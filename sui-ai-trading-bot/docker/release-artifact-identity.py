#!/usr/bin/python3
"""Pin archive identity for the Environment reviewer before signing."""
import hashlib
import importlib.util
import os
from pathlib import Path
import re

sha = os.environ["RELEASE_SHA"]
assert re.fullmatch(r"[a-f0-9]{40}", sha)
with Path("release/image.tar.gz").open("rb") as source:
    archive = hashlib.file_digest(source, "sha256").hexdigest()
assert archive == Path("release/image.tar.gz.sha256").read_text().split()[0]
image = Path("release/image-id.txt").read_text().strip()
assert re.fullmatch(r"sha256:[a-f0-9]{64}", image)
spec = importlib.util.spec_from_file_location("trusted_image_verifier", Path("deploy/broker/broker.py"))
broker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)
config, manifests = broker.archive_identity(Path("release/image.tar.gz"), image, sha)
assert config == image
with open(os.environ["GITHUB_OUTPUT"], "a") as out:
    out.write("archive="+archive+"\nimage="+image+"\n")
with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as out:
    out.write("\nArchive SHA-256 `"+archive+"`\n\nConfig digest `"+image+"`\n\n")
    for manifest in sorted(manifests):
        out.write("Proven manifest `"+manifest+"`\n\n")
