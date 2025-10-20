// server.js
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Load config from env
const PORT = process.env.PORT || 3000;
const partnerCode = process.env.PARTNER_CODE;
const accessKey = process.env.ACCESS_KEY;
const secretKey = process.env.SECRET_KEY;
const momoEndpoint = process.env.MOMO_ENDPOINT || 'https://test-payment.momo.vn/v2/gateway/api/create';
const returnUrl = process.env.RETURN_URL;
const ipnUrl = process.env.IPN_URL;


// Simple in-memory order store for demo (replace by DB in production)
const orders = {};

/**
 * Helper: create hmac sha256 signature
 * raw string must follow MoMo docs ordering exactly.
 */
function createSignature(raw) {
  return crypto.createHmac('sha256', secretKey).update(raw).digest('hex');
}

/**
 * Endpoint: create payment
 * Expects JSON { amount, orderInfo, extraData(optional) }
 */
app.post('/create-payment', async (req, res) => {
  try {
    const { amount, orderInfo = 'Thanh toan MoMo demo', extraData = '' } = req.body;
    if (!amount) return res.status(400).json({ ok: false, message: 'amount is required' });

    const requestId = partnerCode + Date.now();
    const orderId = requestId; // for demo; in prod use DB id or uuid
    const requestType = 'captureWallet';

    // Build raw signature string exactly in this order:
    // accessKey=...&amount=...&extraData=...&ipnUrl=...&orderId=...&orderInfo=...&partnerCode=...&redirectUrl=...&requestId=...&requestType=...
    const rawSignature =
      `accessKey=${accessKey}` +
      `&amount=${amount}` +
      `&extraData=${extraData}` +
      `&ipnUrl=${ipnUrl}` +
      `&orderId=${orderId}` +
      `&orderInfo=${orderInfo}` +
      `&partnerCode=${partnerCode}` +
      `&redirectUrl=${returnUrl}` +
      `&requestId=${requestId}` +
      `&requestType=${requestType}`;

    const signature = createSignature(rawSignature);

    const payload = {
      partnerCode,
      accessKey,
      requestId,
      amount: String(amount),
      orderId,
      orderInfo,
      redirectUrl: returnUrl,
      ipnUrl,
      extraData,
      requestType,
      signature,
      lang: 'vi'
    };

    // Store order locally (demo)
    orders[orderId] = {
      orderId, requestId, amount, orderInfo, status: 'CREATED', createdAt: new Date().toISOString()
    };

    const resp = await axios.post(momoEndpoint, payload, { headers: { 'Content-Type': 'application/json' }, timeout: 30000 });

    // resp.data may contain payUrl inside data.payUrl or payUrl directly depending response
    const data = resp.data || {};
    // Return full response to frontend so it can redirect
    return res.json({ ok: true, momo: data, orderId });

  } catch (err) {
    console.error('create-payment error:', err?.response?.data || err.message || err);
    return res.status(500).json({ ok: false, error: err?.response?.data || err.message });
  }
});

/**
 * IPN endpoint - MoMo server will POST here with payment result
 * We must verify signature and update order status.
 */
app.post('/ipn', (req, res) => {
  const body = req.body || {};
  console.log('/ipn received:', body);

  // Required fields from MoMo IPN (may vary). Build raw signature using docs' ordering.
  // Example fields commonly returned: partnerCode, accessKey, amount, orderId, orderInfo, orderType, transId, message, localMessage, responseTime, errorCode, requestId, payType, extraData, signature, resultCode
  const rawSignature =
    `accessKey=${body.accessKey || accessKey}` +
    `&amount=${body.amount || ''}` +
    `&extraData=${body.extraData || ''}` +
    `&message=${body.message || ''}` +
    `&orderId=${body.orderId || ''}` +
    `&orderInfo=${body.orderInfo || ''}` +
    `&orderType=${body.orderType || ''}` +
    `&partnerCode=${body.partnerCode || ''}` +
    `&payType=${body.payType || ''}` +
    `&requestId=${body.requestId || ''}` +
    `&responseTime=${body.responseTime || ''}` +
    `&resultCode=${body.resultCode || ''}`;

  const verifySignature = createSignature(rawSignature);

  if (verifySignature !== (body.signature || '')) {
    console.warn('IPN signature mismatch');
    return res.status(400).json({ status: 'invalid signature' });
  }

  // Signature ok - check resultCode (0 success)
  const orderId = body.orderId;
  const resultCode = parseInt(body.resultCode || -1);

  // Find stored order (demo)
  if (orders[orderId]) {
    if (resultCode === 0) {
      orders[orderId].status = 'PAID';
      orders[orderId].transId = body.transId || null;
      orders[orderId].updatedAt = new Date().toISOString();
      console.log(`Order ${orderId} marked as PAID`);
    } else {
      orders[orderId].status = 'FAILED';
      orders[orderId].error = body.localMessage || body.message || `code:${body.resultCode}`;
      orders[orderId].updatedAt = new Date().toISOString();
      console.log(`Order ${orderId} payment failed`, orders[orderId].error);
    }
  } else {
    console.log('Order not found in local store (maybe created elsewhere). orderId=', orderId);
  }

  // Return 200 to MoMo
  return res.json({ status: 'OK' });
});

/**
 * Small helper to view orders (demo only)
 */
app.get('/orders', (req, res) => {
  return res.json({ ok: true, orders });
});

app.get('/return', (req, res) => {
    // MoMo redirect kèm query params, ví dụ ?errorCode=0&orderId=...
    const params = req.query || {};
    console.log('/return params:', params);
  
    // Bạn có thể render 1 trang đơn giản or trả JSON
    // Nếu bạn dùng SPA, frontend có thể đọc query params và gọi backend /orders
    res.send(`
      <h2>MoMo Return (kết quả redirect)</h2>
      <pre>${JSON.stringify(params, null, 2)}</pre>
      <p>Bạn có thể đóng tab hoặc kiểm tra backend /orders để xem trạng thái order.</p>
    `);
});

// Start server
app.listen(PORT, () => {
  console.log(`MoMo demo server listening on http://localhost:${PORT}`);
  console.log(`Public index at http://localhost:${PORT}/`);
});
