export function maskLicenseCode(licenseCode: string | null | undefined): string {
  if (!licenseCode) return '';
  const parts = licenseCode.split('-');
  if (parts.length <= 2) {
    return '****-****';
  }
  const first = parts[0];
  const last = parts[parts.length - 1];
  const maskedMiddle = parts.slice(1, -1).map(() => '****').join('-');
  return `${first}-${maskedMiddle}-${last}`;
}
