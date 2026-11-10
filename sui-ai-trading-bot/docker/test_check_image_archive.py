#!/usr/bin/env python3
"""Tests for check-image-archive.py, the CI pre-flight that mirrors
the broker's archive format acceptance, plus the workflow shape that
pins the release image to OCI media types.

Fixtures are synthetic docker-save tarballs: the OCI one is the
format the broker accepts, and each mutation reproduces a rejection
the broker would issue after transfer (the 2026-11-11 incident was
an OCI-index descriptor produced by buildx attestations, confirmed
by the pre-flight's own log output on the first retry)."""
import hashlib
import importlib.util
import io
import json
import os
import tarfile
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")
spec = importlib.util.spec_from_file_location(
    "check_image_archive", os.path.join(HERE, "check-image-archive.py"))
check_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check_mod)

OCI_MANIFEST = check_mod.OCI_MANIFEST
OCI_INDEX = 'application/vnd.oci.image.index.v1+json'
DOCKER_MANIFEST = 'application/vnd.docker.distribution.manifest.v2+json'
OCI_CONFIG = check_mod.OCI_CONFIG
DOCKER_CONFIG = 'application/vnd.docker.container.image.v1+json'
OCI_LAYER = 'application/vnd.oci.image.layer.v1.tar+gzip'
DOCKER_LAYER = 'application/vnd.docker.image.rootfs.diff.tar.gzip'


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def write_tar(path, members):
    with tarfile.open(path, 'w:gz') as archive:
        for name, data in members.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))


class ArchiveFixture:
    """A minimal one-layer image in docker-save form.

    With oci=True the archive also carries the OCI layout the
    containerd image store adds to `docker save` output; the media
    types are parameters so tests can reproduce each broker
    rejection.
    """

    def __init__(self, oci=True, descriptor_type=OCI_MANIFEST,
                 config_type=OCI_CONFIG, layer_type=OCI_LAYER,
                 extra_descriptor=False, corrupt_manifest=False,
                 layer_bytes=b'layer-one'):
        self.layer = layer_bytes
        self.layer_digest = sha256(self.layer)
        config = {
            'architecture': 'amd64', 'os': 'linux',
            'config': {'User': 'node', 'Env': ['MODE=PAPER']},
            'rootfs': {'type': 'layers',
                       'diff_ids': ['sha256:' + self.layer_digest]},
        }
        self.config_raw = json.dumps(config).encode()
        self.config_digest = sha256(self.config_raw)
        self.layer_path = 'blobs/sha256/' + self.layer_digest
        manifest = {
            'schemaVersion': 2, 'mediaType': descriptor_type,
            'config': {'mediaType': config_type,
                       'digest': 'sha256:' + self.config_digest,
                       'size': len(self.config_raw)},
            'layers': [{'mediaType': layer_type,
                        'digest': 'sha256:' + self.layer_digest,
                        'size': len(self.layer)}],
        }
        self.manifest_raw = json.dumps(manifest).encode()
        self.manifest_digest = sha256(self.manifest_raw)
        self.corrupt_manifest = corrupt_manifest
        config_member = ('blobs/sha256/' + self.config_digest if oci
                         else self.config_digest + '.json')
        layer_member = self.layer_path if oci else 'layer1/layer.tar'
        saved = [{'Config': config_member,
                  'RepoTags': ['suiba:test'],
                  'Layers': [layer_member]}]
        self.members = {
            'manifest.json': json.dumps(saved).encode(),
            config_member: self.config_raw,
            layer_member: self.layer,
        }
        if oci:
            descriptor = {'mediaType': descriptor_type,
                          'digest': 'sha256:' + self.manifest_digest,
                          'size': len(self.manifest_raw)}
            manifests = [descriptor]
            if extra_descriptor:
                manifests.append(dict(descriptor))
            index = {'schemaVersion': 2, 'manifests': manifests}
            self.members['oci-layout'] = json.dumps(
                {'imageLayoutVersion': '1.0.0'}).encode()
            self.members['index.json'] = json.dumps(index).encode()
            blob = self.manifest_raw
            if corrupt_manifest:
                # The stored blob no longer matches the digest its
                # name and the index descriptor claim.
                blob += b' '
            self.members['blobs/sha256/' + self.manifest_digest] = blob

    def write_to(self, directory):
        path = os.path.join(directory, 'image.tar.gz')
        write_tar(path, self.members)
        return path


class CheckArchiveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def check(self, fixture):
        return check_mod.check_archive(fixture.write_to(self.tmp.name))

    def assert_rejected(self, fixture):
        with self.assertRaises(check_mod.CheckFailure):
            self.check(fixture)

    def test_oci_archive_is_accepted(self):
        result = self.check(ArchiveFixture())
        self.assertEqual(result['format'], 'oci')
        self.assertEqual(result['manifest_media_type'], OCI_MANIFEST)
        self.assertEqual(result['manifest_digest'],
                         'sha256:' + ArchiveFixture().manifest_digest)

    def test_docker_manifest_media_type_is_rejected(self):
        # oci-layout present, but the single descriptor uses the
        # Docker manifest media type, which the broker rejects as
        # OCI_MEDIA_TYPE after transfer.
        self.assert_rejected(ArchiveFixture(descriptor_type=DOCKER_MANIFEST))

    def test_oci_index_descriptor_is_rejected(self):
        # The 2026-11-11 incident: buildx attestations (provenance)
        # wrap the image in an OCI index, so the single descriptor
        # points at the index instead of the manifest. The broker
        # rejects it as OCI_MEDIA_TYPE; the build therefore pins
        # --provenance=false --sbom=false.
        self.assert_rejected(ArchiveFixture(descriptor_type=OCI_INDEX))

    def test_multiple_descriptors_are_rejected(self):
        self.assert_rejected(ArchiveFixture(extra_descriptor=True))

    def test_docker_config_media_type_is_rejected(self):
        self.assert_rejected(ArchiveFixture(config_type=DOCKER_CONFIG))

    def test_docker_layer_media_type_is_rejected(self):
        self.assert_rejected(ArchiveFixture(layer_type=DOCKER_LAYER))

    def test_corrupt_manifest_blob_is_rejected(self):
        self.assert_rejected(ArchiveFixture(corrupt_manifest=True))

    def test_classic_archive_is_accepted(self):
        result = self.check(ArchiveFixture(oci=False))
        self.assertEqual(result['format'], 'classic')

    def test_classic_layer_mismatch_is_rejected(self):
        fixture = ArchiveFixture(oci=False)
        other = ArchiveFixture(oci=False, layer_bytes=b'other-layer')
        fixture.members['layer1/layer.tar'] = other.layer
        self.assert_rejected(fixture)

    def test_missing_manifest_json_is_rejected(self):
        fixture = ArchiveFixture()
        del fixture.members['manifest.json']
        self.assert_rejected(fixture)


class MainTests(unittest.TestCase):
    def test_main_exit_codes(self):
        with tempfile.TemporaryDirectory() as tmp:
            good = ArchiveFixture().write_to(tmp)
            self.assertEqual(check_mod.main(['check', good]), 0)
            bad = ArchiveFixture(
                descriptor_type=DOCKER_MANIFEST).write_to(tmp)
            self.assertEqual(check_mod.main(['check', bad]), 1)
            self.assertEqual(
                check_mod.main(['check', os.path.join(tmp, 'nope.tar.gz')]),
                1)


class WorkflowShapeTests(unittest.TestCase):
    """Both deploy workflows must build the release image with OCI
    media types pinned and run the archive pre-flight on the saved
    tar before it is uploaded or transferred."""

    WORKFLOWS = ['suiba-vps.yml', 'suiba-paper-deploy-cycle.yml']

    @classmethod
    def setUpClass(cls):
        cls.sources = {}
        for name in cls.WORKFLOWS:
            with open(os.path.join(ROOT, '.github', 'workflows', name),
                      encoding='utf-8') as fh:
                cls.sources[name] = fh.read()

    def test_build_uses_buildx_with_oci_media_types(self):
        for name, source in self.sources.items():
            with self.subTest(workflow=name):
                self.assertIn('docker buildx build', source)
                self.assertIn('--output type=docker,oci-mediatypes=true',
                              source)
                self.assertIn('--provenance=false', source)
                self.assertIn('--sbom=false', source)
                self.assertIn('--build-arg SUIBA_BUILD_SHA=${{ github.sha }}',
                              source)
                self.assertIn('-f sui-ai-trading-bot/docker/Dockerfile',
                              source)
                self.assertIn('-t suiba:${{ github.sha }}', source)
                self.assertNotIn('run: docker build ', source)

    def test_package_step_checks_the_saved_archive(self):
        for name, source in self.sources.items():
            with self.subTest(workflow=name):
                self.assertIn(
                    'python3 sui-ai-trading-bot/docker/'
                    'check-image-archive.py release/image.tar.gz', source)
                save_at = source.index('docker save suiba:')
                check_at = source.index('check-image-archive.py')
                self.assertLess(save_at, check_at)


if __name__ == '__main__':
    unittest.main()
