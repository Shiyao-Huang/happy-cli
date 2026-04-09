import qrcode from 'qrcode-terminal';
import { t } from '@/i18n';

/**
 * Display a QR code in the terminal for the given URL
 */
export function displayQRCode(url: string): void {
  console.log('='.repeat(80));
  console.log(t('qrcode.scanPrompt'));
  console.log('='.repeat(80));
  qrcode.generate(url, { small: true }, (qr) => {
    for (let l of qr.split('\n')) {
      console.log(' '.repeat(10) + l);
    }
  });
  console.log('='.repeat(80));
}
