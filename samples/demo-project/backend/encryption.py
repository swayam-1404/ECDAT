from Crypto.Cipher import AES
from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305


def encrypt_record(key: bytes, nonce: bytes, payload: bytes):
    cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)  # AES-256-GCM when a 32-byte key is supplied.
    ciphertext, tag = cipher.encrypt_and_digest(payload)
    return ciphertext, tag


def modern_cipher(key: bytes):
    return ChaCha20Poly1305(key)

