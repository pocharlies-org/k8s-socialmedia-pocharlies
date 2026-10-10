// The connector HMAC gate lives in shared (SKIRM-112: the Instagram connector mounts the same one).
export {
  createHMACAuth,
  generateHMACSignature,
  type AuthenticatedRequest,
  type HMACRejectReason,
} from '@mcp-socialmedia/shared';
