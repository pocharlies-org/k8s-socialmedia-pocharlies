import express, { Request, Response } from 'express';
import { QRHandler } from '../qr-handler';
import { createHMACAuth } from './auth';

/** The QR of the pending pairing, in the shape v1 has always answered (404 when there is none). */
export function sendCurrentQR(qrHandler: QRHandler, res: Response): void {
  const qr = qrHandler.getCurrentQR();
  if (!qr) {
    res.status(404).json({ error: 'No QR code available' });
    return;
  }
  res.json({
    qrCode: qr.qrCode,
    expiresAt: qr.expiresAt.toISOString(),
  });
}

/** Mounted at /api/v2 by main.ts. Born without consumers: v1's `replaced_by` has to resolve to something. */
export function createAuthQrV2Router(qrHandler: QRHandler, sharedSecret: string): express.Router {
  const router = express.Router();
  // CONTRACT: http.whatsapp-connector.auth-qr.v2 — GET /api/v2/auth/qr, HMAC-signed, the payload of v1
  router.get('/auth/qr', createHMACAuth(sharedSecret), (_req: Request, res: Response) => {
    sendCurrentQR(qrHandler, res);
  });
  return router;
}
