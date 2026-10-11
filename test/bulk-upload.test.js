const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const duckdb = require('duckdb');
const { once } = require('node:events');

const {
  app,
  clampSampleSize,
  MAX_UPLOAD_BYTES,
  MAX_SAMPLE_ROWS
} = require('../server');

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

function csvWithQuestions(n) {
  const lines = ['question'];
  for (let i = 1; i <= n; i++) lines.push(`q${i}`);
  return Buffer.from(lines.join('\n'));
}

function dataRows(body) {
  return body.trim().split(/\r?\n/).slice(1).filter(Boolean).map((row) => {
    if (row.startsWith('"') && row.endsWith('"')) {
      return row.slice(1, -1).replace(/""/g, '"');
    }
    return row;
  });
}

function encodeMultipart(fields, file) {
  const boundary = `----CursorBulkBoundary${Date.now()}${Math.random().toString(16).slice(2)}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
    ));
  }
  if (file) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
    ));
    parts.push(file.content);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(parts) };
}

function postBulk(port, fields, file) {
  const { boundary, body } = encodeMultipart(fields, file);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/bulk/debate',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function getText(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: urlPath }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    }).on('error', reject);
  });
}

function dbRun(con, sql) {
  return new Promise((resolve, reject) => {
    con.run(sql, (err) => (err ? reject(err) : resolve()));
  });
}

async function writeParquet(rowCount) {
  const destination = path.join(os.tmpdir(), `bulk-questions-${Date.now()}-${rowCount}.parquet`);
  const db = new duckdb.Database(':memory:');
  const con = db.connect();
  try {
    await dbRun(
      con,
      `COPY (SELECT 'q' || i AS question FROM range(${rowCount}) t(i)) TO '${destination}' (FORMAT PARQUET)`
    );
  } finally {
    await new Promise((resolve) => con.close(() => resolve()));
    db.close();
  }
  return destination;
}

async function waitForNoUploads() {
  const start = Date.now();
  while (Date.now() - start < 2000) {
    if (!fs.existsSync(UPLOADS_DIR)) return;
    const leftover = fs.readdirSync(UPLOADS_DIR).filter((name) => name !== '.gitkeep');
    if (leftover.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const leftover = fs.existsSync(UPLOADS_DIR) ? fs.readdirSync(UPLOADS_DIR) : [];
  throw new Error(`uploads were not removed: ${leftover.join(', ')}`);
}

describe('bulk upload limits', () => {
  let server;
  let port;

  before(async () => {
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    port = server.address().port;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await waitForNoUploads();
  });

  it('clamps sample size to 1..100', () => {
    assert.equal(clampSampleSize(undefined), MAX_SAMPLE_ROWS);
    assert.equal(clampSampleSize(''), MAX_SAMPLE_ROWS);
    assert.equal(clampSampleSize('5000'), MAX_SAMPLE_ROWS);
    assert.equal(clampSampleSize('0'), MAX_SAMPLE_ROWS);
    assert.equal(clampSampleSize('abc'), MAX_SAMPLE_ROWS);
    assert.equal(clampSampleSize('-4'), 1);
    assert.equal(clampSampleSize('1'), 1);
    assert.equal(clampSampleSize('50'), 50);
    assert.equal(clampSampleSize('2.9'), 2);
    assert.equal(clampSampleSize('1; DROP TABLE questions'), 1);
  });

  it('shows the file-size and sample caps on the bulk page', async () => {
    const res = await getText(port, '/bulk');
    assert.equal(res.status, 200);
    assert.match(res.body, new RegExp(`value="${MAX_SAMPLE_ROWS}"`));
    assert.match(res.body, new RegExp(`max="${MAX_SAMPLE_ROWS}"`));
    assert.match(res.body, /5&nbsp;MB max/);
    assert.match(res.body, /At most 100 questions are sampled/);
    assert.match(res.body, /File exceeds the 5 MB upload limit/);
  });

  it('caps CSV rows even when sample is omitted or huge', async () => {
    const file = { filename: 'questions.csv', content: csvWithQuestions(150) };

    const huge = await postBulk(port, { sample: '5000', skip: '1' }, file);
    assert.equal(huge.status, 200, huge.body);
    const hugeRows = dataRows(huge.body);
    assert.equal(hugeRows.length, MAX_SAMPLE_ROWS);
    assert.equal(hugeRows[0], 'q1');
    assert.equal(hugeRows[99], 'q100');
    assert.equal(hugeRows.includes('q101'), false);

    const omitted = await postBulk(port, { skip: '1' }, file);
    assert.equal(omitted.status, 200, omitted.body);
    assert.equal(dataRows(omitted.body).length, MAX_SAMPLE_ROWS);

    const small = await postBulk(port, { sample: '3', skip: '1' }, file);
    assert.equal(small.status, 200, small.body);
    assert.deepEqual(dataRows(small.body), ['q1', 'q2', 'q3']);
    await waitForNoUploads();
  });

  it('treats a non-numeric sample as the cap and keeps SQL fragments numeric', async () => {
    const file = { filename: 'questions.csv', content: csvWithQuestions(150) };
    const injected = await postBulk(port, { sample: '1; DROP TABLE questions', skip: '1' }, file);
    assert.equal(injected.status, 200, injected.body);
    assert.deepEqual(dataRows(injected.body), ['q1']);
    await waitForNoUploads();
  });

  it('rejects a missing file and a csv without a question column', async () => {
    const missing = await postBulk(port, { sample: '10', skip: '1' });
    assert.equal(missing.status, 400);
    assert.match(missing.body, /No file uploaded/);

    const rejected = await postBulk(
      port,
      { sample: '10', skip: '1' },
      { filename: 'notes.csv', content: Buffer.from('title\nhello\n') }
    );
    assert.equal(rejected.status, 400);
    assert.match(rejected.body, /question/);
    await waitForNoUploads();
  });

  it('accepts .CSV and rejects other extensions before writing them', async () => {
    const before = fs.existsSync(UPLOADS_DIR) ? fs.readdirSync(UPLOADS_DIR) : [];
    const rejected = await postBulk(
      port,
      { sample: '10', skip: '1' },
      { filename: 'notes.txt', content: csvWithQuestions(2) }
    );
    assert.equal(rejected.status, 400);
    assert.match(rejected.body, /Only \.csv and \.parquet files are allowed/);
    const after = fs.existsSync(UPLOADS_DIR) ? fs.readdirSync(UPLOADS_DIR) : [];
    assert.deepEqual(after, before);

    const allowed = await postBulk(
      port,
      { sample: '10', skip: '1' },
      { filename: 'Questions.CSV', content: csvWithQuestions(2) }
    );
    assert.equal(allowed.status, 200, allowed.body);
    assert.deepEqual(dataRows(allowed.body), ['q1', 'q2']);
    await waitForNoUploads();
  });

  it('rejects an upload larger than 5 MB and accepts one at the limit', async () => {
    const header = Buffer.from('question\n');
    const atLimit = Buffer.concat([
      header,
      Buffer.alloc(MAX_UPLOAD_BYTES - header.length - 1, 0x61),
      Buffer.from('\n')
    ]);
    assert.equal(atLimit.length, MAX_UPLOAD_BYTES);

    const accepted = await postBulk(
      port,
      { sample: '1', skip: '1' },
      { filename: 'at-limit.csv', content: atLimit }
    );
    assert.equal(accepted.status, 200, accepted.body);
    assert.equal(dataRows(accepted.body).length, 1);

    const over = Buffer.concat([atLimit, Buffer.from('x')]);
    const rejected = await postBulk(
      port,
      { sample: '1', skip: '1' },
      { filename: 'over-limit.csv', content: over }
    );
    assert.equal(rejected.status, 413);
    assert.match(rejected.body, /5 MB upload limit/);
    await waitForNoUploads();
  });

  it('applies the sample cap to parquet files', async () => {
    const parquetPath = await writeParquet(150);
    try {
      const content = fs.readFileSync(parquetPath);
      const capped = await postBulk(
        port,
        { sample: '5000', skip: '1' },
        { filename: 'questions.parquet', content }
      );
      assert.equal(capped.status, 200, capped.body);
      const rows = dataRows(capped.body);
      assert.equal(rows.length, MAX_SAMPLE_ROWS);
      assert.equal(rows.every((row) => /^"?q\d+"?$/.test(row)), true);

      const small = await postBulk(
        port,
        { sample: '4', skip: '1' },
        { filename: 'questions.parquet', content }
      );
      assert.equal(small.status, 200, small.body);
      assert.equal(dataRows(small.body).length, 4);
    } finally {
      fs.unlinkSync(parquetPath);
      await waitForNoUploads();
    }
  });
});
