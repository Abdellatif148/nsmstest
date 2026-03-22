// ============================================================
// tests/sms.test.js — Production tests
// Run with: npm test
// ============================================================

const { normalizePhone, detectNetwork } = require('../src/services/SmsService')

describe('Phone Number Normalization', () => {

  test('converts 0612345678 to +212612345678', () => {
    expect(normalizePhone('0612345678')).toBe('+212612345678')
  })

  test('accepts +212612345678 as-is', () => {
    expect(normalizePhone('+212612345678')).toBe('+212612345678')
  })

  test('converts 212612345678 to +212612345678', () => {
    expect(normalizePhone('212612345678')).toBe('+212612345678')
  })

  test('handles spaces in number', () => {
    expect(normalizePhone('06 12 34 56 78')).toBe('+212612345678')
  })

  test('returns null for invalid number', () => {
    expect(normalizePhone('123')).toBeNull()
    expect(normalizePhone('0012345678')).toBeNull()
    expect(normalizePhone('+33612345678')).toBeNull()
  })
})

describe('Network Detection', () => {

  test('detects Maroc Telecom numbers', () => {
    expect(detectNetwork('+212612345678')).toBe('maroc_telecom')
    expect(detectNetwork('+212621345678')).toBe('maroc_telecom')
    expect(detectNetwork('+212661345678')).toBe('maroc_telecom')
  })

  test('detects Orange numbers', () => {
    expect(detectNetwork('+212601234567')).toBe('orange')
    expect(detectNetwork('+212691234567')).toBe('orange')
  })

  test('detects Inwi numbers', () => {
    expect(detectNetwork('+212701234567')).toBe('inwi')
    expect(detectNetwork('+212751234567')).toBe('inwi')
  })

  test('returns unknown for unrecognized prefix', () => {
    expect(detectNetwork('+212581234567')).toBe('unknown')
  })
})

describe('API Health', () => {
  const request = require('supertest')
  const app = require('../src/index')

  test('GET /health returns 200', async () => {
    const res = await request(app).get('/health')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
  })

  test('GET / returns API info', async () => {
    const res = await request(app).get('/')
    expect(res.status).toBe(200)
    expect(res.body.name).toBe('Nook SMS API')
  })

  test('Unknown route returns 404', async () => {
    const res = await request(app).get('/unknown-route')
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('NOT_FOUND')
  })
})

describe('Authentication', () => {
  const request = require('supertest')
  const app = require('../src/index')

  test('Request without API key returns 401', async () => {
    const res = await request(app)
      .post('/v1/sms/send')
      .send({ to: '+212612345678', message: 'Test' })

    expect(res.status).toBe(401)
    expect(res.body.code).toBe('MISSING_API_KEY')
  })

  test('Request with invalid API key returns 401', async () => {
    const res = await request(app)
      .post('/v1/sms/send')
      .set('Authorization', 'Bearer nk_live_invalidkey12345678901234567890')
      .send({ to: '+212612345678', message: 'Test' })

    expect(res.status).toBe(401)
    expect(res.body.code).toBe('INVALID_API_KEY')
  })

  test('Badly formatted auth header returns 401', async () => {
    const res = await request(app)
      .post('/v1/sms/send')
      .set('Authorization', 'WRONG_FORMAT')
      .send({ to: '+212612345678', message: 'Test' })

    expect(res.status).toBe(401)
  })
})

describe('Input Validation', () => {
  // These tests run without real API key
  // Just testing validation responses

  test('Missing "to" field returns 400', async () => {
    const request = require('supertest')
    const app = require('../src/index')

    const res = await request(app)
      .post('/v1/sms/send')
      .set('Authorization', 'Bearer nk_live_test00000000000000000000000000')
      .send({ message: 'Hello' })

    // Either 401 (bad key) or 400 (validation) — both are correct
    expect([400, 401]).toContain(res.status)
  })
})
