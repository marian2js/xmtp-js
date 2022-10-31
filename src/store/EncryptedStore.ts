import { Store } from './Store'
import { Signer } from 'ethers'
import {
  PrivateKeyBundleV1,
  decodePrivateKeyBundle,
  decrypt,
  encrypt,
  WalletSigner,
} from '../crypto'
import { KeyStore } from './KeyStore'
import { Authenticator } from '../authn'
import { bytesToHex, getRandomValues, hexToBytes } from '../crypto/utils'
import Ciphertext from '../crypto/Ciphertext'
import { privateKey as proto } from '@xmtp/proto'

const KEY_BUNDLE_NAME = 'key_bundle'
/**
 * EncryptedKeyStore wraps Store to enable encryption of private key bundles
 * using a wallet signature.
 */
export default class EncryptedKeyStore implements KeyStore {
  private store: Store
  private signer: Signer

  constructor(signer: Signer, store: Store) {
    this.signer = signer
    this.store = store
  }

  private async getStorageAddress(name: string): Promise<string> {
    // I think we want to namespace the storage address by wallet
    // This will allow us to support switching between multiple wallets in the same browser
    const walletAddress = await this.signer.getAddress()
    return `${walletAddress}/${name}`
  }

  // Retrieve a private key bundle for the active wallet address in the signer
  async loadPrivateKeyBundle(): Promise<PrivateKeyBundleV1 | null> {
    const storageBuffer = await this.store.get(
      await this.getStorageAddress(KEY_BUNDLE_NAME)
    )
    if (!storageBuffer) {
      return null
    }

    const [bundle, needsUpdate] = await this.fromEncryptedBytes(
      this.signer,
      Uint8Array.from(storageBuffer)
    )
    // If a versioned bundle is not found, the legacy bundle needs to be resaved to the store in
    // the new format. Once all bundles have been upgraded, this migration code can be removed.
    if (needsUpdate) {
      await this.storePrivateKeyBundle(bundle)
    }
    return bundle
  }

  // Store the private key bundle at an address generated based on the active wallet in the signer
  async storePrivateKeyBundle(bundle: PrivateKeyBundleV1): Promise<void> {
    const keyAddress = await this.getStorageAddress(KEY_BUNDLE_NAME)
    const encodedBundle = await this.toEncryptedBytes(bundle, this.signer)
    // We need to setup the Authenticator so that the underlying store can publish messages without error
    if (typeof this.store.setAuthenticator === 'function') {
      this.store.setAuthenticator(new Authenticator(bundle.identityKey))
    }
    await this.store.set(keyAddress, Buffer.from(encodedBundle))
  }

  // encrypts/serializes the bundle for storage
  async toEncryptedBytes(
    bundle: PrivateKeyBundleV1,
    wallet: Signer
  ): Promise<Uint8Array> {
    // serialize the contents
    const bytes = bundle.encode()
    const wPreKey = getRandomValues(new Uint8Array(32))
    const msg = storageSigRequestText(wPreKey)
    const sigString = await wallet.signMessage(msg)

    // validate the signature to make sure what the signer returned is indeed
    // a wallet signature of wPreKey.
    // It seems that at least LedgerLive on iOS can return wrong signature
    // in some circumstances.
    const sig = WalletSigner.stringToSignature(sigString).walletEcdsaCompact
    if (!sig) {
      throw new Error('invalid storage signature')
    }
    const key = WalletSigner.signerKeyForMessage(msg, sig)
    if (!key || key.getEthereumAddress() !== (await wallet.getAddress())) {
      throw new Error('invalid storage signature')
    }

    // All checks out, use the signature as secret key.
    const secret = hexToBytes(sigString)
    const ciphertext = await encrypt(bytes, secret)
    return proto.EncryptedPrivateKeyBundle.encode({
      v1: {
        walletPreKey: wPreKey,
        ciphertext,
      },
    }).finish()
  }

  // decrypts/deserializes the bundle from storage bytes
  async fromEncryptedBytes(
    wallet: Signer,
    bytes: Uint8Array
  ): Promise<[PrivateKeyBundleV1, boolean]> {
    const [eBundle, needsUpdate] = getEncryptedBundle(bytes)

    if (!eBundle.walletPreKey) {
      throw new Error('missing wallet pre-key')
    }
    if (!eBundle.ciphertext?.aes256GcmHkdfSha256) {
      throw new Error('missing bundle ciphertext')
    }

    const secret = hexToBytes(
      await wallet.signMessage(storageSigRequestText(eBundle.walletPreKey))
    )
    const ciphertext = new Ciphertext(eBundle.ciphertext)
    const decrypted = await decrypt(ciphertext, secret)
    const [bundle, needsUpdate2] = getPrivateBundle(decrypted)
    return [bundle, needsUpdate || needsUpdate2]
  }
}

// getEncryptedV1Bundle returns the decoded bundle from the provided bytes. If there is an error decoding the bundle it attempts
// to decode the bundle as a legacy bundle. Additionally return whether the bundle is in the expected format.
function getEncryptedBundle(
  bytes: Uint8Array
): [proto.EncryptedPrivateKeyBundleV1, boolean] {
  try {
    const b = proto.EncryptedPrivateKeyBundle.decode(bytes)
    if (b.v1) {
      return [b.v1, false]
    }
  } catch (e) {
    return [proto.EncryptedPrivateKeyBundleV1.decode(bytes), true]
  }
  throw new Error('unrecognized encrypted private key bundle version')
}

// getPrivateV1Bundle returns the decoded bundle from the provided bytes. If there is an error decoding the bundle it attempts
// to decode the bundle as a legacy bundle. Additionally return whether the bundle is in the expected format.
function getPrivateBundle(bytes: Uint8Array): [PrivateKeyBundleV1, boolean] {
  try {
    // TODO: add support for V2
    const b = decodePrivateKeyBundle(bytes) as PrivateKeyBundleV1
    return [b, false]
  } catch (e) {
    // Adds a default fallback for older versions of the proto
    const b = proto.PrivateKeyBundleV1.decode(bytes)
    return [new PrivateKeyBundleV1(b), true]
  }
}

export function storageSigRequestText(preKey: Uint8Array): string {
  // Note that an update to this signature request text will require
  // addition of backward compatibility for existing encrypted bundles
  // and/or a migration; otherwise clients will no longer be able to
  // decrypt those bundles.
  return (
    'XMTP : Enable Identity\n' +
    `${bytesToHex(preKey)}\n` +
    '\n' +
    'For more info: https://xmtp.org/signatures/'
  )
}
