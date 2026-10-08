'use strict';

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

let masterKey = null;

function setMasterKey(keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) {
    throw new Error('MASTER_KEY must be a 32-byte (64 hex char) secret. Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  masterKey = key;
}

function ensureKey() {
  if (!masterKey) throw new Error('Master key not set. Call setMasterKey() first.');
}

// Encrypts a plaintext secret. Returns "iv:authTag:ciphertext" (all base64).
function encrypt(plaintext) {
  ensureKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':');
}

// Decrypts a value produced by encrypt(). Verified via GCM auth tag.
function decrypt(payload) {
  ensureKey();
  const [ivB64, tagB64, dataB64] = payload.split(':');
  const decipher = crypto.createDecipheriv(ALGO, masterKey, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

module.exports = { setMasterKey, encrypt, decrypt };
