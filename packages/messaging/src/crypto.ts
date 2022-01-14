import * as secp from "@noble/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { Key } from "readline";

// crypto should provide access to standard Web Crypto API
// in both the browser environment and node. 
const crypto: Crypto =
    typeof window !== "undefined" ?
        window.crypto :
        require("crypto").webcrypto as unknown as Crypto;

export const AESKeySize = 32;
export const KDFSaltSize = 32;
// AES-GCM defaults from https://developer.mozilla.org/en-US/docs/Web/API/AesGcmParams
export const AESGCMNonceSize = 12; // property iv
export const AESGCMTagLength = 16; // property tagLength

// Signature represents an ECDSA signature with recovery bit.
export class Signature {
    bytes: Uint8Array; // compact format [ R || S ], 64 bytes
    recovery: number; // recovery bit 0 | 1
    constructor(bytes:Uint8Array, recovery: number) {
        if (bytes.length != 64) {
            throw new Error(`Invalid signature length: ${bytes.length}`);
        };
        this.bytes = bytes;
        if (recovery !== 0 && recovery !== 1) {
            throw new Error(`Invalid recovery bit: ${recovery}`);
        };
        this.recovery = recovery;
    };
    // If the signature is valid for the provided digest
    // then return the public key that validates it.
    // Otherwise return undefined.
    getPublicKey(digest: Uint8Array): PublicKey | undefined {
        const bytes = secp.recoverPublicKey(digest, this.bytes, this.recovery);
        return bytes ? PublicKey.fromBytes(bytes) : undefined;
    };
    // If the signature is valid for the provided digest
    // return the address derived from te public key that validest it.
    // Otherwise return undefined.
    getEthereumAddress(digest: Uint8Array): string | undefined {
        const pub = this.getPublicKey(digest);
        if (!pub) { return undefined };
        return pub.getEthereumAddress();
     };
};

// Ciphertext packages the encrypted payload with the salt and nonce used to produce it.
// salt and nonce are not secret, and should be transmitted/stored along with the encrypted payload.
export class Ciphertext {
    payload: Uint8Array; // at least AESGCMTagLength bytes
    salt: Uint8Array; // hkdf salt 
    nonce: Uint8Array; // aes-256-gcm IV
    constructor(payload: Uint8Array, salt: Uint8Array, nonce: Uint8Array) {
        if (payload.length < AESGCMTagLength) {
            throw new Error(`Invalid ciphertext payload length: ${payload.length}`);
        };
        if (salt.length != KDFSaltSize) {
            throw new Error(`Invalid ciphertext salt length: ${salt.length}`);
        };
        if (nonce.length != AESGCMNonceSize) {
            throw new Error(`Invalid ciphertext nonce length: ${nonce.length}`);
        };
        this.payload = payload;
        this.salt = salt;
        this.nonce = nonce;
    };
};

// PrivateKey represents a secp256k1 private key.
export class PrivateKey {
    bytes: Uint8Array; // 32 bytes
    constructor (bytes: Uint8Array) {
        if (bytes.length != 32) {
            throw new Error(`Invalid private key length: ${bytes.length}`);
        };
        this.bytes = bytes };
    static generate(): PrivateKey {
        return new PrivateKey(secp.utils.randomPrivateKey());
    };
    static fromBytes(bytes: Uint8Array): PrivateKey {
        return new PrivateKey(bytes);
    };
    async sign(digest: Uint8Array):Promise<Signature> {
        const [signature, recovery] = await secp.sign(digest, this.bytes, {recovered: true, der: false});
        return new Signature(signature, recovery);
    };
    async signKey(pub: PublicKey):Promise<PublicKey>{
        const digest = await secp.utils.sha256(pub.bytes);
        pub.signature = await this.sign(digest);
        return pub;
    };
    getPublicKey(): PublicKey {
        return PublicKey.fromPrivateKey(this);
    };
    sharedSecret(peer: PublicKey): Uint8Array {
        return secp.getSharedSecret(this.bytes, peer.bytes, false);
    };
    encrypt(plain: Uint8Array, peer: PublicKey, additionalData?: Uint8Array):Promise<Ciphertext> {
        const secret = this.sharedSecret(peer);
        return encrypt(plain, secret, additionalData);
    };
    decrypt(encrypted: Ciphertext, peer: PublicKey, additionalData?: Uint8Array): Promise<Uint8Array> {
        const secret = this.sharedSecret(peer);
        return decrypt(encrypted, secret, additionalData);
    };
};

// PublicKey respresents uncompressed secp256k1 public key,
// that can optionally be signed with another trusted key pair.
export class PublicKey {
    bytes: Uint8Array; // uncompressed point [ P || X || Y ], 65 bytes
    signature?: Signature;
    constructor(bytes: Uint8Array, signature?: Signature) {
        if (bytes.length != 65) {
            throw new Error(`Invalid public key length: ${bytes.length}`);
        };
        if (bytes[0] != 4) {
            throw new Error(`Unrecognized public key prefix: ${bytes[0]}`);
        }
        this.bytes = bytes;
        this.signature = signature;
    };
    static fromPrivateKey(pri: PrivateKey): PublicKey {
      return new PublicKey(secp.getPublicKey(pri.bytes));
    };
    static fromBytes(bytes: Uint8Array): PublicKey {
        return new PublicKey(bytes);
    }
    verify(signature: Signature, digest: Uint8Array):boolean {
        return secp.verify(signature.bytes, digest, this.bytes);
    }
    async verifyKey(pub: PublicKey):Promise<boolean> {
        if (typeof pub.signature === undefined) { return false };
        let digest = await secp.utils.sha256(pub.bytes);
        return pub.signature ? this.verify(pub.signature, digest) : false;
    };
    getEthereumAddress(): string {
        // drop the uncompressed format prefix byte
        const key = this.bytes.slice(1)
        const bytes = keccak_256(key).subarray(-20);
        return "0x"+secp.utils.bytesToHex(bytes);
    };
};

// Generates a new secp256k1 key pair.
export function generateKeys(): [PrivateKey, PublicKey] {
    const pri = PrivateKey.generate();
    const pub = PublicKey.fromPrivateKey(pri);
    return [pri, pub];
};

// KeyBundle packages all the keys that a participant should advertise.
// The PreKey must be signed by the IdentityKey.
// The IdentityKey can be signed by the wallet to authenticate it.
export class KeyBundle {
    identityKey: PublicKey;
    preKey: PublicKey;
    constructor(identityKey: PublicKey, preKey: PublicKey) {
        this.identityKey = identityKey;
        this.preKey = preKey;
    };
};

// PrivateKeyBundle bundles the private keys corresponding to a KeyBundle for convenience.
// This bundle must not be shared with anyone, although will have to be persisted
// somehow so that older messages can be decrypted again.
export class PrivateKeyBundle {
    identityKey: PrivateKey;
    preKey: PrivateKey;
    constructor(identityKey: PrivateKey, preKey: PrivateKey) {
        this.identityKey = identityKey;
        this.preKey = preKey;
    };
    // sharedSecret derives a secret from peers' key bundles using a variation of X3DH protocol
    // where the sender's ephemeral key pair is replaced by the sender's prekey.
    async sharedSecret(peer: KeyBundle, receiver: boolean): Promise<Uint8Array> {
        if(! await peer.identityKey.verifyKey(peer.preKey)) {
            throw new Error("peer preKey signature invalid");
        };
        let dh1: Uint8Array, dh2: Uint8Array;
        if (receiver) {
            dh1 = this.preKey.sharedSecret(peer.identityKey);
            dh2 = this.identityKey.sharedSecret(peer.preKey);
        } else {
            dh1 = this.identityKey.sharedSecret(peer.preKey);
            dh2 = this.preKey.sharedSecret(peer.identityKey);
        };
        let dh3 = this.preKey.sharedSecret(peer.preKey);
        let secret = new Uint8Array(dh1.length+dh2.length+dh3.length);
        secret.set(dh1,0);
        secret.set(dh2,dh1.length);
        secret.set(dh3,dh1.length+dh2.length);
        return secret;
    };
    // encrypt the plaintext with a symmetric key derived from the peers' key bundles.
    async encrypt(plain: Uint8Array, receiver: KeyBundle): Promise<Ciphertext> {
        let secret = await this.sharedSecret(receiver, false);
        return encrypt(plain, secret);
    };
    // decrypt the encrypted content using a symmetric key derived from the peers' key bundles.
    async decrypt(encrypted: Ciphertext, sender: KeyBundle): Promise<Uint8Array> {
        let secret = await this.sharedSecret(sender, true);
        return decrypt(encrypted, secret);
    };
};

// Generate a new key bundle pair with the preKey signed byt the identityKey.
export async function generateBundles(): Promise<[PrivateKeyBundle, KeyBundle]> {
    let [priIdentityKey, pubIdentityKey] = generateKeys();
    let [priPreKey, pubPreKey] = generateKeys();
    await priIdentityKey.signKey(pubPreKey);
    return [
        new PrivateKeyBundle(priIdentityKey, priPreKey),
        new KeyBundle(pubIdentityKey, pubPreKey)
    ];
};

const emptyBuffer = new ArrayBuffer(0);

// Derive AES-256-GCM key from a shared secret and salt.
// Returns crypto.CryptoKey suitable for the encrypt/decrypt API
async function hkdf(secret: Uint8Array, salt: Uint8Array):Promise<CryptoKey> {
    const key = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
        {name: "HKDF", hash: "SHA-256", salt: salt, info: emptyBuffer},
        key,
        {name: "AES-GCM", length: 256},
        false,
        ["encrypt", "decrypt"]);
};

async function encrypt(plain: Uint8Array, secret: Uint8Array, additionalData?: Uint8Array):Promise<Ciphertext> {
    let salt = crypto.getRandomValues(new Uint8Array(KDFSaltSize));
    let nonce = crypto.getRandomValues(new Uint8Array(AESGCMNonceSize));
    const key = await hkdf(secret, salt);
    const encrypted: ArrayBuffer = await crypto.subtle.encrypt(
        aesGcmParams(nonce, additionalData),
        key,
        plain);
    return new Ciphertext(new Uint8Array(encrypted), salt, nonce);
};

async function decrypt(encrypted: Ciphertext, secret: Uint8Array, additionalData?: Uint8Array): Promise<Uint8Array> {
    const key = await hkdf(secret, encrypted.salt);
    const decrypted: ArrayBuffer = await crypto.subtle.decrypt(
        aesGcmParams(encrypted.nonce, additionalData),
        key,
        encrypted.payload);
    return new Uint8Array(decrypted)
};

function aesGcmParams(nonce: Uint8Array, additionalData?: Uint8Array): AesGcmParams {
    let spec: AesGcmParams = {
        name: "AES-GCM",
        iv: nonce };
    if (additionalData) {
        spec.additionalData = additionalData
    };
    return spec;
};

// utility functions
export const getRandomValues = crypto.getRandomValues;
export const bytesToHex = secp.utils.bytesToHex;
export function hexToBytes(s: string): Uint8Array {
    let bytes = new Uint8Array(s.length/2);
    for (let i=0; i<bytes.length; i++) {
      let j = i*2;
      bytes[i] = Number.parseInt(s.slice(j, j+2), 16);
    };
    return bytes;
};