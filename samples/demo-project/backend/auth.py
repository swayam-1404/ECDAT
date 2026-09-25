"""Deliberately mixed cryptography for the ECDAT demo."""

import hashlib
from cryptography.hazmat.primitives.asymmetric import rsa


def create_session_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def legacy_account_fingerprint(account_id: bytes) -> str:
    return hashlib.sha1(account_id).hexdigest()

