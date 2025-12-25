import express from 'express';
import {
  mintRealtimeToken,
  startRealtimeSession,
  endRealtimeSession,
  realtimeWebhook,
  postRealtimeMetrics,
  twilioInboundStub,
  verifyRealtimeCredentials,
  getRealtimeAgentConfig
} from '../controllers/realtimeController.js';

const router = express.Router();

router.get('/health', (req, res) => {
  res.json({
    ok: true,
    hasLivekit: !!process.env.LIVEKIT_URL && !!process.env.LIVEKIT_API_KEY && !!process.env.LIVEKIT_API_SECRET,
    livekitUrl: process.env.LIVEKIT_URL ? String(process.env.LIVEKIT_URL) : null,
    egressEnabled: !!process.env.LIVEKIT_EGRESS_ENABLED,
    hasS3:
      !!process.env.S3_BUCKET &&
      !!process.env.AWS_REGION &&
      !!process.env.AWS_ACCESS_KEY_ID &&
      !!process.env.AWS_SECRET_ACCESS_KEY
  });
});

router.get('/verify', verifyRealtimeCredentials);

// Optional-auth route; public access supported via `publicToken` in body.
router.post('/token', mintRealtimeToken);
router.post('/config', getRealtimeAgentConfig);
router.post('/start', startRealtimeSession);
router.post('/end', endRealtimeSession);
router.post('/webhook', realtimeWebhook);
router.post('/metrics', postRealtimeMetrics);
// PSTN (Twilio) placeholder endpoints
router.post('/pstn/inbound', twilioInboundStub);

export default router;

