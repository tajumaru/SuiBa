#!/usr/bin/env python3
"""CI pre-flight for the release image archive (image.tar.gz).

The VPS broker (deploy/broker/broker.py, archive_identity) validates
the docker-save archive's format before it deploys anything, and a
format mismatch is only reported as a bare rejection code after the
archive has already been transferred to the host. On 2026-11-11 two
deploys in a row were rejected with OCI_MEDIA_TYPE: the runner's
`docker build` + `docker save` produced a tar that carried an
oci-layout whose single index descriptor used the Docker manifest
media type instead of the OCI one.

This checker mirrors the broker's format acceptance so the same
archive fails here, in CI, before any transfer:

- manifest.json lists exactly one image.
- With an oci-layout: index.json has schemaVersion 2 and exactly one
  descriptor; the descriptor's mediaType is the OCI image manifest
  type; the manifest blob matches its descriptor digest/size; the
  manifest's own mediaType matches the descriptor; the config media
  type is the OCI config type and its digest/size match the config
  in manifest.json; every layer uses an OCI layer media type and its
  blob matches manifest.json's Layers entry.
- Without an oci-layout (classic docker save): the config file is
  named by its own sha256 and the layer contents hash to the
  config's rootfs diff_ids.

It deliberately does not re-check image content policy (user, env,
revision label): the broker remains the authority for that. Usage:

    check-image-archive.py <path-to-image.tar.gz>

Exit 0 and a format summary on stdout when the broker's format
checks would accept the archive; exit 1 with the reason otherwise.
"""
import hashlib
import json
import re
import sys
import tarfile

OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json'
OCI_CONFIG = 'application/vnd.oci.image.config.v1+json'
OCI_LAYER_TYPES = (
    'application/vnd.oci.image.layer.v1.tar',
    'application/vnd.oci.image.layer.v1.tar+gzip',
    'application/vnd.oci.image.layer.v1.tar+zstd',
)
DIGEST = re.compile(r'sha256:[0-9a-f]{64}\Z')
SMALL_LIMIT = 1024 ** 2


class CheckFailure(Exception):
    """The archive would fail the broker's format checks."""


def require(condition, message):
    if not condition:
        raise CheckFailure(message)


def load_archive(path):
    """Hash every member; keep members up to 1MiB in memory.

    Same bookkeeping as the broker: objects maps name -> (sha256,
    size); small maps name -> bytes for the small members.
    """
    objects, small = {}, {}
    with tarfile.open(path, 'r:*') as archive:
        for member in archive:
            name = member.name
            require(name not in objects and not name.startswith('/')
                    and '..' not in name.split('/')
                    and '\\' not in name,
                    f'unsafe or duplicate archive path: {name!r}')
            if member.isdir():
                continue
            require(member.isfile(),
                    f'archive member is not a regular file: {name!r}')
            digest, data = hashlib.sha256(), bytearray()
            with archive.extractfile(member) as source:
                for block in iter(lambda: source.read(SMALL_LIMIT), b''):
                    digest.update(block)
                    if member.size <= SMALL_LIMIT:
                        data.extend(block)
            hexdigest = digest.hexdigest()
            if name.startswith('blobs/sha256/'):
                require(name == 'blobs/sha256/' + hexdigest,
                        f'blob name does not match its content: {name!r}')
            objects[name] = (hexdigest, member.size)
            if member.size <= SMALL_LIMIT:
                small[name] = bytes(data)
    return objects, small


def decode(small, name):
    require(name in small, f'{name} missing from archive')
    try:
        return json.loads(small[name])
    except ValueError:
        raise CheckFailure(f'{name} is not valid JSON')


def check_oci(objects, small, saved, config, config_raw, config_id):
    require(decode(small, 'oci-layout') == {'imageLayoutVersion': '1.0.0'},
            'oci-layout is not {"imageLayoutVersion": "1.0.0"}')
    index = decode(small, 'index.json')
    require(index.get('schemaVersion') == 2,
            f"index.json schemaVersion is {index.get('schemaVersion')!r}, "
            'expected 2')
    descriptors = index.get('manifests')
    require(isinstance(descriptors, list), 'index.json has no manifests list')
    require(len(descriptors) == 1,
            f'index.json lists {len(descriptors)} manifests, expected 1')
    descriptor = descriptors[0]
    print(f"index descriptor mediaType: {descriptor.get('mediaType')}")
    print(f"index descriptor digest: {descriptor.get('digest')}")
    require(descriptor.get('mediaType') == OCI_MANIFEST,
            f"index descriptor mediaType is "
            f"{descriptor.get('mediaType')!r}, expected {OCI_MANIFEST!r} "
            '(the broker rejects this as OCI_MEDIA_TYPE)')
    digest = descriptor.get('digest', '')
    require(DIGEST.fullmatch(digest),
            f'index descriptor digest is malformed: {digest!r}')
    name = 'blobs/sha256/' + digest[7:]
    require(objects.get(name) == (digest[7:], descriptor.get('size')),
            'manifest blob does not match its index descriptor')
    manifest = decode(small, name)
    require(manifest.get('schemaVersion') == 2
            and manifest.get('mediaType') == descriptor['mediaType'],
            'manifest schemaVersion/mediaType does not match its descriptor')
    manifest_config = manifest.get('config', {})
    print(f"manifest config mediaType: {manifest_config.get('mediaType')}")
    require(manifest_config.get('mediaType') == OCI_CONFIG
            and manifest_config.get('digest') == config_id
            and manifest_config.get('size') == len(config_raw),
            'manifest config is not the OCI-typed config named by '
            'manifest.json')
    layers = manifest.get('layers', [])
    diff_ids = config.get('rootfs', {}).get('diff_ids', [])
    require(len(layers) == len(saved['Layers']) == len(diff_ids),
            f"layer counts differ: manifest {len(layers)}, "
            f"manifest.json {len(saved['Layers'])}, diff_ids {len(diff_ids)}")
    for layer, layer_path in zip(layers, saved['Layers']):
        print(f"layer mediaType: {layer.get('mediaType')}")
        require(layer.get('mediaType') in OCI_LAYER_TYPES
                and DIGEST.fullmatch(layer.get('digest', ''))
                and layer_path == 'blobs/sha256/' + layer['digest'][7:]
                and objects.get(layer_path)
                == (layer['digest'][7:], layer.get('size')),
                f"layer {layer.get('digest')!r} is not an OCI-typed blob "
                'matching manifest.json')
    return {'format': 'oci', 'manifest_media_type': descriptor['mediaType'],
            'manifest_digest': digest}


def check_classic(objects, saved, config, config_path, config_id):
    require(config_path == config_id[7:] + '.json',
            'classic archive config is not named by its own sha256')
    layer_hashes = []
    for name in saved['Layers']:
        require(name in objects, f'layer {name!r} missing from archive')
        layer_hashes.append('sha256:' + objects[name][0])
    require(layer_hashes == config.get('rootfs', {}).get('diff_ids'),
            'classic layer contents do not hash to the config diff_ids')
    return {'format': 'classic', 'manifest_media_type': None,
            'manifest_digest': None}


def check_archive(path):
    objects, small = load_archive(path)
    saved_list = decode(small, 'manifest.json')
    require(isinstance(saved_list, list) and len(saved_list) == 1,
            'manifest.json must list exactly one image')
    saved = saved_list[0]
    config_path = saved['Config']
    require(config_path in small,
            f'config {config_path!r} missing from archive')
    config_raw = small[config_path]
    config = json.loads(config_raw)
    config_id = 'sha256:' + objects[config_path][0]
    if 'oci-layout' in small:
        result = check_oci(objects, small, saved, config,
                           config_raw, config_id)
    else:
        result = check_classic(objects, saved, config,
                               config_path, config_id)
    print(f"archive format: {result['format']}")
    return result


def main(argv):
    if len(argv) != 2:
        print(f'usage: {argv[0]} <image.tar.gz>', file=sys.stderr)
        return 2
    try:
        check_archive(argv[1])
    except (CheckFailure, tarfile.TarError, OSError,
            ValueError, KeyError) as error:
        print(f'image archive check FAILED: {error}', file=sys.stderr)
        return 1
    print('image archive check: OK')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
