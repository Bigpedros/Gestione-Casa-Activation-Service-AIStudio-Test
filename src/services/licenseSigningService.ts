import crypto from 'node:crypto';
import {
  buildCanonicalLicensePayloadV1,
  buildCanonicalValidationReceiptV1,
  type SignedLicenseDocument,
  type SignedValidationReceiptV1,
  type ValidationReceiptV1,
} from '@gestione-casa/shared-sdk/activation';
import type { LicenseDocument, LicenseDocumentV1 } from '@gestione-casa/shared-sdk/licensing';

export class LicenseSigningService {
  /**
   * Generates a runtime Ed25519 key pair for testing or ephemeral signing.
   */
  public static generateKeyPair(): { publicKey: string; privateKey: string } {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    return { publicKey, privateKey };
  }

  /**
   * Builds canonical payload V1 and signs it with the provided private key using Ed25519.
   */
  public static signLicense(
    document: LicenseDocument | Record<string, unknown>,
    privateKeyPemOrBase64: string,
    keyId: string
  ): SignedLicenseDocument {
    const canonicalPayload = buildCanonicalLicensePayloadV1(document as unknown as LicenseDocument);
    
    let privateKeyInput: crypto.KeyObject | string = privateKeyPemOrBase64;
    if (!privateKeyPemOrBase64.includes('BEGIN')) {
      privateKeyInput = crypto.createPrivateKey({
        key: Buffer.from(privateKeyPemOrBase64, 'base64'),
        format: 'der',
        type: 'pkcs8',
      });
    }

    const signatureBuffer = crypto.sign(
      null,
      Buffer.from(canonicalPayload, 'utf8'),
      privateKeyInput
    );
    const signature = signatureBuffer.toString('hex');

    return {
      license: document as LicenseDocumentV1,
      signature,
      signatureAlgorithm: 'Ed25519',
      keyId,
      signatureVersion: 1,
      canonicalPayload,
    };
  }

  /**
   * Verifies the signature of a SignedLicenseDocument.
   */
  public static verifySignedLicense(
    signedDoc: SignedLicenseDocument,
    publicKeyPemOrBase64: string
  ): boolean {
    if (!signedDoc || !signedDoc.license || !signedDoc.signature) {
      return false;
    }
    const { license, signature, signatureVersion, signatureAlgorithm } = signedDoc;
    if (signatureVersion !== 1 || signatureAlgorithm !== 'Ed25519') {
      return false;
    }

    const canonicalPayload = buildCanonicalLicensePayloadV1(license);

    let publicKeyInput: crypto.KeyObject | string = publicKeyPemOrBase64;
    if (!publicKeyPemOrBase64.includes('BEGIN')) {
      publicKeyInput = crypto.createPublicKey({
        key: Buffer.from(publicKeyPemOrBase64, 'base64'),
        format: 'der',
        type: 'spki',
      });
    }

    return crypto.verify(
      null,
      Buffer.from(canonicalPayload, 'utf8'),
      publicKeyInput,
      Buffer.from(signature, 'hex')
    );
  }

  /**
   * Canonicalizes a ValidationReceiptV1 and signs it with the provided private key using Ed25519.
   * Signature is encoded in Base64 as required by SignedValidationReceiptV1 contract.
   */
  public static signValidationReceipt(
    receipt: ValidationReceiptV1,
    privateKeyPemOrBase64: string,
    keyId: string
  ): SignedValidationReceiptV1 {
    const canonicalPayload = buildCanonicalValidationReceiptV1(receipt);

    let privateKeyInput: crypto.KeyObject | string = privateKeyPemOrBase64;
    if (!privateKeyPemOrBase64.includes('BEGIN')) {
      privateKeyInput = crypto.createPrivateKey({
        key: Buffer.from(privateKeyPemOrBase64, 'base64'),
        format: 'der',
        type: 'pkcs8',
      });
    }

    const signatureBuffer = crypto.sign(
      null,
      Buffer.from(canonicalPayload, 'utf8'),
      privateKeyInput
    );
    const signature = signatureBuffer.toString('base64');

    return {
      receipt,
      signature,
      signatureAlgorithm: 'Ed25519',
      keyId,
      signatureVersion: 1,
      canonicalPayload,
    };
  }

  /**
   * Verifies the signature of a SignedValidationReceiptV1.
   */
  public static verifySignedValidationReceipt(
    signedReceipt: SignedValidationReceiptV1,
    publicKeyPemOrBase64: string
  ): boolean {
    if (!signedReceipt || !signedReceipt.receipt || !signedReceipt.signature) {
      return false;
    }
    const { receipt, signature, signatureVersion, signatureAlgorithm } = signedReceipt;
    if (signatureVersion !== 1 || signatureAlgorithm !== 'Ed25519') {
      return false;
    }

    const canonicalPayload = buildCanonicalValidationReceiptV1(receipt);

    let publicKeyInput: crypto.KeyObject | string = publicKeyPemOrBase64;
    if (!publicKeyPemOrBase64.includes('BEGIN')) {
      publicKeyInput = crypto.createPublicKey({
        key: Buffer.from(publicKeyPemOrBase64, 'base64'),
        format: 'der',
        type: 'spki',
      });
    }

    return crypto.verify(
      null,
      Buffer.from(canonicalPayload, 'utf8'),
      publicKeyInput,
      Buffer.from(signature, 'base64')
    );
  }
}
