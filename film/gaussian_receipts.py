"""Verify camera-copy provenance before accepting Gaussian background plates."""
import gzip
import hashlib
import json
from pathlib import Path
import re
import struct

COPY_POLICY = 'spark-2.3.1-center-clip-1.5-spz2-byte-subset-all-frame-exact-v1'
SHA = re.compile(r'[0-9a-f]{64}\Z')


def _hash(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def _spz_count(path):
    try:
        with gzip.open(path, 'rb') as stream:
            header = stream.read(16)
        magic, version, count, degree, bits, flags, reserved = struct.unpack('<IIIBBBB', header)
        if magic != 0x5053474e or version != 2 or degree != 0 or bits > 24 or flags or reserved:
            raise ValueError('Unsupported camera-copy SPZ header')
        return count
    except (OSError, struct.error) as error:
        raise ValueError('Camera-copy SPZ header is invalid') from error


def validate_world_copy(output, asset, profile):
    """A subset is optional, but its exact all-frame proof is mandatory if used."""
    receipt = profile.get('worldCopy')
    if receipt is None:
        return  # Historical captures and fixture manifests remain literal.
    if (not isinstance(receipt, dict) or receipt.get('policy') != COPY_POLICY
            or receipt.get('sourceSha256') != asset['sha256']):
        raise ValueError('Camera-copy receipt does not match the canonical Gaussian source')
    if receipt.get('status') == 'full-source':
        if not isinstance(receipt.get('reason'), str) or not receipt['reason']:
            raise ValueError('Full-source camera-copy fallback must report its reason')
        return
    if (receipt.get('status') != 'verified' or asset['format'] != 'spz'
            or any(not isinstance(receipt.get(key), str) or not SHA.fullmatch(receipt[key])
                   for key in ('key', 'copySha256', 'qualityDigest'))
            or receipt.get('width') != profile['width'] or receipt.get('height') != profile['height']
            or receipt.get('frameNumbers') != profile['frameNumbers']):
        raise ValueError('Camera-copy receipt is incomplete or has different camera frames')
    for key in ('sourcePoints', 'copyPoints', 'sourceBytes', 'copyBytes'):
        if type(receipt.get(key)) is not int or receipt[key] <= 0:
            raise ValueError('Camera-copy counts and sizes must be positive integers')
    if not receipt['copyPoints'] < receipt['sourcePoints'] <= 2_000_000:
        raise ValueError('Camera copy must retain a proper subset of the source points')
    output = Path(output)
    source = output / asset['path']
    copy = output / 'plate' / 'world-copy.spz'
    proof_path = output / 'plate' / 'world-copy-quality.json'
    if (copy.is_symlink() or not copy.is_file() or source.is_symlink() or not source.is_file()
            or copy.stat().st_size != receipt['copyBytes'] or source.stat().st_size != receipt['sourceBytes']
            or _hash(copy) != receipt['copySha256'] or _hash(source) != asset['sha256']
            or _spz_count(copy) != receipt['copyPoints'] or _spz_count(source) != receipt['sourcePoints']):
        raise ValueError('Camera-copy bytes or original source changed after verification')
    if proof_path.is_symlink() or not proof_path.is_file() or proof_path.stat().st_size > 32 * 1024 * 1024:
        raise ValueError('Camera-copy full-source quality proof is missing or invalid')
    proof_bytes = proof_path.read_bytes()
    if hashlib.sha256(proof_bytes).hexdigest() != receipt['qualityDigest']:
        raise ValueError('Camera-copy quality proof changed after verification')
    try:
        proof = json.loads(proof_bytes)
    except ValueError as error:
        raise ValueError('Camera-copy quality proof is invalid') from error
    if (not isinstance(proof, dict) or type(proof.get('schemaVersion')) is not int or proof['schemaVersion'] != 1
            or any(proof.get(key) != receipt[key] for key in ('status', 'policy', 'key', 'sourceSha256', 'copySha256'))):
        raise ValueError('Camera-copy quality proof has a different source or copy identity')
    frames = proof.get('frameProofs')
    if not isinstance(frames, list) or len(frames) != len(receipt['frameNumbers']):
        raise ValueError('Camera-copy quality proof must cover every requested frame')
    for number, frame in zip(receipt['frameNumbers'], frames):
        if (not isinstance(frame, dict) or type(frame.get('frame')) is not int or frame['frame'] != number
                or not isinstance(frame.get('reference'), str) or not SHA.fullmatch(frame['reference'])
                or frame.get('copy') != frame['reference']):
            raise ValueError('Camera-copy quality proof must match exact full-source pixels at every frame')
