require('dotenv').config();
const express   = require('express');
const fs        = require('fs');
const path      = require('path');
const multer    = require('multer');
const duckdb   = require('duckdb');
const csvParser = require('csv-parser');
const {Parser}  = require('json2csv');

const DebateService = require('./debateService');

// OpenAI API
const API_KEY = process.env.OPENAI_API_KEY;
const API_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-3.5-turbo";

/* ---------- basic server / middleware ---------- */
const app  = express();
const port = process.env.PORT || 3000;

// Built-in body parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public')); // optional, for serving static files (CSS/JS)

const debateSvc = new DebateService(process.env.OPENAI_API_KEY);

/* ------------------------------------------------------------------
   Small helpers – one-shot & debate wrappers used by the pages / API
------------------------------------------------------------------ */
async function getZeroShotAnswer(q) {
  return debateSvc.oneShot(q);          // thin wrapper
}

async function runDebate(q, rounds = 1) {
  return debateSvc.debate(q, rounds);   // returns {roundData, final}
}

// ========== One-Shot (Zero-Shot) Answer Function ==========
async function getZeroShotResponse(query) {
  const messages = [
    { role: "user", content: `Question: ${query}\nProvide a clear and concise answer.` }
  ];
  const data = {
    model: MODEL,
    messages,
    max_tokens: 150,
    temperature: 0.7
  };

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify(data)
    });
    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
    }
    const json = await response.json();
    const answer = json.choices[0].message.content.trim();
    return answer;
  } catch (error) {
    console.error("Error in getZeroShotResponse:", error);
    return "Error retrieving answer.";
  }
}

// ========== Multiagent Debate Function (Round-by-Round) ==========
async function multiagentDebate(query, rounds = 1) {
  // We'll store the data for each round here:
  const roundData = [];

  let currentQuery = query;       // The question or the last consensus
  let consensusAnswer = "";       // The final synthesis after each round

  for (let i = 0; i < rounds; i++) {
    try {
      // -------- Agent 1's detailed answer --------
      const agent1Messages = [
        { role: "user", content: `Question: ${currentQuery}\nProvide a detailed answer.` }
      ];
      const agent1Response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEY}`
        },
        body: JSON.stringify({
          model: MODEL,
          messages: agent1Messages,
          max_tokens: 200,
          temperature: 0.7
        })
      });
      const agent1Json = await agent1Response.json();
      const agent1Answer = agent1Json.choices[0].message.content.trim();

      // -------- Agent 2's detailed answer --------
      const agent2Messages = [
        { role: "user", content: `Question: ${currentQuery}\nProvide a detailed answer.` }
      ];
      const agent2Response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEY}`
        },
        body: JSON.stringify({
          model: MODEL,
          messages: agent2Messages,
          max_tokens: 200,
          temperature: 0.7
        })
      });
      const agent2Json = await agent2Response.json();
      const agent2Answer = agent2Json.choices[0].message.content.trim();

      // -------- Moderator / Debate Step --------
      const debateMessages = [
        { role: "system", content: "You are an AI debate moderator. Analyze the two responses and provide a consensus answer that corrects any errors." },
        { role: "user", content: `Agent 1: ${agent1Answer}\nAgent 2: ${agent2Answer}\n\nBased on these responses, provide a final consensus answer for the question: ${currentQuery}` }
      ];

      const debateResponse = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEY}`
        },
        body: JSON.stringify({
          model: MODEL,
          messages: debateMessages,
          max_tokens: 200,
          temperature: 0.7
        })
      });
      const debateJson = await debateResponse.json();
      consensusAnswer = debateJson.choices[0].message.content.trim();

      // Store this round’s data so we can display it in the UI
      roundData.push({
        roundNumber: i + 1,
        agent1Answer,
        agent2Answer,
        moderatorAnswer: consensusAnswer
      });

      // The consensus from this round becomes the next "query" to refine
      currentQuery = consensusAnswer;

    } catch (error) {
      console.error("Error in multiagentDebate:", error);
      return {
        roundData,
        finalAnswer: "Error during debate process."
      };
    }
  }

  // Return the entire array of round data plus the final answer
  return {
    roundData,
    finalAnswer: consensusAnswer
  };
}

// ========== Sample Queries for the 2 Pages ==========
const legalQuery = "How might the interpretation of the Fourth Amendment adapt to modern surveillance challenges?";
const mathQuery = "Given a rectangle whose length is three times its width and whose perimeter is 64 units, what is its area?";

// ========== Express Routes ==========

// ---------- Home Page ----------
app.get('/', (req, res) => {
  res.send(`
  <!DOCTYPE html>
  <html>
    <head>
      <title>Home</title>
      <link rel="stylesheet" href="https://maxcdn.bootstrapcdn.com/bootstrap/4.5.2/css/bootstrap.min.css">
    </head>
    <body>
      <div class="container mt-4">
        <h1>Welcome</h1>
        <p>Select a use case:</p>
        <ul>
          <li><a href="/legal">Legal Use Case</a></li>
          <li><a href="/math">Math Question</a></li>
          <li><a href="/bulk">Bulk Benchmark Upload</a></li>
        </ul>
      </div>
    </body>
  </html>
  `);
});

// ---------- Legal Page ----------
app.get('/legal', (req, res) => {
  res.send(`
  <!DOCTYPE html>
  <html>
  <head>
    <title>Legal Use Case</title>
    <link rel="stylesheet" href="https://maxcdn.bootstrapcdn.com/bootstrap/4.5.2/css/bootstrap.min.css">
    <style>
      .section { border: 1px solid #ddd; padding: 20px; margin-bottom: 20px; }
      .round-section { background: #f9f9f9; padding: 10px; margin: 10px 0; }
      .round-title { font-weight: bold; }
      .final-answer { background: #e1ffe1; padding: 10px; margin-top: 20px; border: 1px solid #bbb; }
    </style>
  </head>
  <body>
    <div class="container">
      <nav class="mt-3">
        <a href="/">Home</a> | <a href="/legal">Legal</a> | <a href="/math">Math</a> | <a href="/bulk">Bulk Upload</a>
      </nav>
      <h1 class="mt-4">Legal Use Case</h1>
      <div class="row">
        <!-- One-Shot Section -->
        <div class="col-md-6 section">
          <h3>One-Shot Approach</h3>
          <p><strong>Question:</strong> ${legalQuery}</p>
          <button id="oneShotBtn" class="btn btn-primary">Get Zero-Shot Answer</button>
          <div id="oneShotResult" class="mt-3"></div>
        </div>
        <!-- Debate Section -->
        <div class="col-md-6 section">
          <h3>Debate Approach</h3>
          <p><strong>Question:</strong> ${legalQuery}</p>
          <div class="form-group">
            <label for="roundsInput">Number of Rounds:</label>
            <input type="number" id="roundsInput" class="form-control" value="1" min="1">
          </div>
          <button id="debateBtn" class="btn btn-secondary">Start Debate</button>
          <div id="debateRounds" class="mt-3"></div>
          <div id="debateFinal" class="final-answer"></div>
        </div>
      </div>
    </div>

    <script>
      document.getElementById('oneShotBtn').addEventListener('click', async () => {
        document.getElementById('oneShotResult').innerText = "Loading...";
        const response = await fetch('/api/legal/one-shot', { 
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        const data = await response.json();
        document.getElementById('oneShotResult').innerText = data.answer;
      });

      document.getElementById('debateBtn').addEventListener('click', async () => {
        const rounds = document.getElementById('roundsInput').value;
        document.getElementById('debateRounds').innerHTML = "Loading...";
        document.getElementById('debateFinal').innerHTML = "";

        const response = await fetch('/api/legal/debate', { 
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rounds: rounds })
        });
        const data = await response.json();

        // Clear the placeholder
        document.getElementById('debateRounds').innerHTML = "";
        
        // Display each round’s data
        data.roundData.forEach(round => {
          const roundDiv = document.createElement('div');
          roundDiv.classList.add('round-section');
          roundDiv.innerHTML = \`
            <div class="round-title">Round \${round.roundNumber}</div>
            <p><strong>Agent 1:</strong> \${round.agent1Answer}</p>
            <p><strong>Agent 2:</strong> \${round.agent2Answer}</p>
            <p><strong>Moderator:</strong> \${round.moderatorAnswer}</p>
          \`;
          document.getElementById('debateRounds').appendChild(roundDiv);
        });

        // Show final synthesis at the bottom
        const finalAnswer = data.finalAnswer || "No final answer returned.";
        document.getElementById('debateFinal').innerHTML = "<strong>Final Synthesis:</strong> " + finalAnswer;
      });
    </script>
  </body>
  </html>
  `);
});

// ---------- Math Page ----------
app.get('/math', (req, res) => {
  res.send(`
  <!DOCTYPE html>
  <html>
  <head>
    <title>Math Question</title>
    <link rel="stylesheet" href="https://maxcdn.bootstrapcdn.com/bootstrap/4.5.2/css/bootstrap.min.css">
    <style>
      .section { border: 1px solid #ddd; padding: 20px; margin-bottom: 20px; }
      .round-section { background: #f9f9f9; padding: 10px; margin: 10px 0; }
      .round-title { font-weight: bold; }
      .final-answer { background: #e1ffe1; padding: 10px; margin-top: 20px; border: 1px solid #bbb; }
    </style>
  </head>
  <body>
    <div class="container">
      <nav class="mt-3">
        <a href="/">Home</a> | <a href="/legal">Legal</a> | <a href="/math">Math</a> | <a href="/bulk">Bulk Upload</a>
      </nav>
      <h1 class="mt-4">Math Question</h1>
      <div class="row">
        <!-- One-Shot Section -->
        <div class="col-md-6 section">
          <h3>One-Shot Approach</h3>
          <p><strong>Question:</strong> ${mathQuery}</p>
          <button id="oneShotBtnMath" class="btn btn-primary">Get Zero-Shot Answer</button>
          <div id="oneShotResultMath" class="mt-3"></div>
        </div>
        <!-- Debate Section -->
        <div class="col-md-6 section">
          <h3>Debate Approach</h3>
          <p><strong>Question:</strong> ${mathQuery}</p>
          <div class="form-group">
            <label for="roundsInputMath">Number of Rounds:</label>
            <input type="number" id="roundsInputMath" class="form-control" value="1" min="1">
          </div>
          <button id="debateBtnMath" class="btn btn-secondary">Start Debate</button>
          <div id="debateRoundsMath" class="mt-3"></div>
          <div id="debateFinalMath" class="final-answer"></div>
        </div>
      </div>
    </div>

    <script>
      document.getElementById('oneShotBtnMath').addEventListener('click', async () => {
        document.getElementById('oneShotResultMath').innerText = "Loading...";
        const response = await fetch('/api/math/one-shot', { 
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        const data = await response.json();
        document.getElementById('oneShotResultMath').innerText = data.answer;
      });

      document.getElementById('debateBtnMath').addEventListener('click', async () => {
        const rounds = document.getElementById('roundsInputMath').value;
        document.getElementById('debateRoundsMath').innerHTML = "Loading...";
        document.getElementById('debateFinalMath').innerHTML = "";

        const response = await fetch('/api/math/debate', { 
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rounds: rounds })
        });
        const data = await response.json();

        // Clear the placeholder
        document.getElementById('debateRoundsMath').innerHTML = "";
        
        // Display each round’s data
        data.roundData.forEach(round => {
          const roundDiv = document.createElement('div');
          roundDiv.classList.add('round-section');
          roundDiv.innerHTML = \`
            <div class="round-title">Round \${round.roundNumber}</div>
            <p><strong>Agent 1:</strong> \${round.agent1Answer}</p>
            <p><strong>Agent 2:</strong> \${round.agent2Answer}</p>
            <p><strong>Moderator:</strong> \${round.moderatorAnswer}</p>
          \`;
          document.getElementById('debateRoundsMath').appendChild(roundDiv);
        });

        // Show final synthesis at the bottom
        const finalAnswer = data.finalAnswer || "No final answer returned.";
        document.getElementById('debateFinalMath').innerHTML = "<strong>Final Synthesis:</strong> " + finalAnswer;
      });
    </script>
  </body>
  </html>
  `);
});

// ------ Bulk Page ------
app.get('/bulk', (_, res) => res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Bulk Debate Dataset</title>
  <link rel="stylesheet" href="https://maxcdn.bootstrapcdn.com/bootstrap/4.5.2/css/bootstrap.min.css">
</head>
<body>
  <div class="container">
    <nav class="mt-3">
      <a href="/">Home</a> | <a href="/legal">Legal</a> | <a href="/math">Math</a> | <a href="/bulk">Bulk</a>
    </nav>
    <h1 class="mt-4">Bulk Debate Dataset</h1>
    <p>Upload a <code>.parquet</code> or <code>.csv</code> file (${MAX_UPLOAD_BYTES / (1024 * 1024)}&nbsp;MB max) that contains a column named <code>question</code>.
       At most ${MAX_SAMPLE_ROWS} questions are sampled. The server runs one debate per sampled question and returns a CSV with the answers.</p>

    <form id="uploadForm" enctype="multipart/form-data">
      <div class="form-group">
        <input type="file" class="form-control-file" id="fileInput" name="file" accept=".parquet,.csv" required>
      </div>
    <div class="form-group">
    <label for="sampleInput">Sample size (rows):</label>
    <input type="number" id="sampleInput" class="form-control"
           value="${MAX_SAMPLE_ROWS}" min="1" max="${MAX_SAMPLE_ROWS}">
  </div>
  <div class="form-check mb-3">
    <input class="form-check-input" type="checkbox" id="skipInference">
    <label class="form-check-label" for="skipInference">
      Don’t call the model (just give me the sampled rows)
    </label>
  </div>
      <button type="submit" class="btn btn-primary">Run Debate</button>
    </form>

    <div id="status" class="mt-3"></div>
  </div>

<script>
document.getElementById('uploadForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  const status = document.getElementById('status');
  const file   = document.getElementById('fileInput').files[0];
  const sample = document.getElementById('sampleInput').value;
  const skip   = document.getElementById('skipInference').checked ? '1' : '0';

  if (!file) {
    status.textContent = 'Choose a file first';
    return;
  }
  if (file.size > ${MAX_UPLOAD_BYTES}) {
    status.textContent = 'File exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB upload limit.';
    return;
  }

  status.textContent = 'Uploading & processing – please wait…';

  const fd = new FormData();
  fd.append('file', file);
  fd.append('sample', sample);   // 1..${MAX_SAMPLE_ROWS}
  fd.append('skip',   skip);     // "1" or "0"

  try {
    const r = await fetch('/api/bulk/debate', { method: 'POST', body: fd });
    if (!r.ok) {
      const msg = (await r.text()).trim();
      throw new Error(msg || ('Server ' + r.status));
    }

    const blob = await r.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = r.headers.get('content-disposition')?.includes('sampled')
      ? 'sampled_questions.csv'
      : 'debate_results.csv';
    document.body.appendChild(a);
    a.click();
    URL.revokeObjectURL(url);
    a.remove();

    status.innerHTML = '<span class="text-success">Finished – download started.</span>';
  } catch (err) {
    status.innerHTML = '<span class="text-danger">Error: ' + err.message + '</span>';
  }
});
</script>
</body>
</html>
`));

// ========== API Endpoints ==========

// ---- Legal Endpoints ----
app.post('/api/legal/one-shot', async (req, res) => {
  try {
    const answer = await getZeroShotResponse(legalQuery);
    res.json({ answer });
  } catch (error) {
    console.error("API Error:", error);
    res.status(500).json({ answer: "Error processing request." });
  }
});

app.post('/api/legal/debate', async (req, res) => {
  const rounds = req.body.rounds ? parseInt(req.body.rounds) : 1;
  try {
    const result = await multiagentDebate(legalQuery, rounds);
    res.json(result); // { roundData: [...], finalAnswer: "..." }
  } catch (error) {
    console.error("API Error:", error);
    res.status(500).json({ finalAnswer: "Error processing request." });
  }
});

// ---- Math Endpoints ----
app.post('/api/math/one-shot', async (req, res) => {
  try {
    const answer = await getZeroShotResponse(mathQuery);
    res.json({ answer });
  } catch (error) {
    console.error("API Error:", error);
    res.status(500).json({ answer: "Error processing request." });
  }
});

app.post('/api/math/debate', async (req, res) => {
  const rounds = req.body.rounds ? parseInt(req.body.rounds) : 1;
  try {
    const result = await multiagentDebate(mathQuery, rounds);
    res.json(result); // { roundData: [...], finalAnswer: "..." }
  } catch (error) {
    console.error("API Error:", error);
    res.status(500).json({ finalAnswer: "Error processing request." });
  }
});

/* ------------------------------------------------------------------
   UPLOAD CONFIGURATION
------------------------------------------------------------------ */
const crypto = require('crypto');

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_SAMPLE_ROWS = 100;
const ALLOWED_UPLOAD_EXTS = new Set(['.csv', '.parquet']);

function clampSampleSize(raw) {
  return Math.min(
    Math.max(parseInt(raw || String(MAX_SAMPLE_ROWS), 10) || MAX_SAMPLE_ROWS, 1),
    MAX_SAMPLE_ROWS
  );
}

function datasetFileFilter(req, file, cb) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (ALLOWED_UPLOAD_EXTS.has(ext)) return cb(null, true);
  cb(new Error('Only .csv and .parquet files are allowed.'));
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads');
    fs.mkdirSync(dir, { recursive: true });          // ensure folder exists
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const safeExt = ALLOWED_UPLOAD_EXTS.has(ext) ? ext : '';
    cb(null, `${crypto.randomUUID()}${safeExt}`);
  }
});

const upload = multer({
  storage,
  // Busboy reports the limit once the file reaches this size, so the ceiling
  // is one byte above the 5 MB maximum we accept.
  limits: { fileSize: MAX_UPLOAD_BYTES + 1, files: 1 },
  fileFilter: datasetFileFilter
});

function rejectUpload(err, res) {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).send('File exceeds the 5 MB upload limit.');
  }
  const message = err instanceof multer.MulterError
    ? 'Upload rejected.'
    : (err.message || 'Upload rejected.');
  return res.status(400).send(message);
}

/* ------------------------------------------------------------------
   BULK DATASET ENDPOINT  –  accepts .parquet or .csv
------------------------------------------------------------------ */
app.post('/api/bulk/debate', (req, res) => {
  upload.single('file')(req, res, (uploadErr) => {
    if (uploadErr) return rejectUpload(uploadErr, res);
    handleBulkDebate(req, res).catch((error) => {
      console.error('Bulk debate error:', error);
      if (!res.headersSent) res.status(500).send('Error processing upload.');
    });
  });
});

async function handleBulkDebate(req, res) {
  if (!req.file) return res.status(400).send('No file uploaded');

  const SAMPLE_N   = clampSampleSize(req.body.sample);
  const SKIP_MODEL = req.body.skip === '1';
  const questions  = [];

  const fullPath   = path.resolve(req.file.path);        // absolute
  const escaped    = fullPath.replace(/\\/g, '\\\\')     // Windows safety (harmless on Linux)
                              .replace(/'/g,  "''");     // quote escaping

  try {
    /* ---------- 1.  Try Parquet first if extension is .parquet ---------- */
    let parquetOK = false;
    if (path.extname(fullPath).toLowerCase() === '.parquet') {
      const db  = new duckdb.Database(':memory:');
      const con = db.connect();
      try {
        const rows = await new Promise((resolve, reject) => {
          con.all(
            `SELECT question
               FROM read_parquet('${escaped}')
              WHERE question IS NOT NULL
              ORDER BY random()
              LIMIT ${SAMPLE_N}`,
            (err, result) => (err ? reject(err) : resolve(result || []))
          );
        });
        for (const row of rows) {
          if (row && row.question && questions.length < SAMPLE_N) questions.push(row.question);
        }
        parquetOK = true;
      } catch (e) {
        console.error('Parquet read failed, will try CSV fallback:', e.message);
      } finally {
        await new Promise((resolve) => con.close(() => resolve()));
        db.close();
      }
    }

    /* ---------- 2.  CSV fallback ---------- */
    if (!parquetOK) {
      try {
        await new Promise((ok, bad) => {
          fs.createReadStream(fullPath)
            .pipe(csvParser())
            .on('data', r => {
              if (questions.length >= SAMPLE_N) return;
              if (r.question) questions.push(r.question);
            })
            .on('end', ok)
            .on('error', bad);
        });
      } catch (csvErr) {
        console.error('CSV fallback failed', csvErr);
        return res.status(400)
          .send('File must be a valid Parquet or CSV with a "question" column');
      }
    }

    // Apply the same row cap on every path. Parquet also uses LIMIT above.
    questions.splice(SAMPLE_N);

    if (!questions.length) {
      return res.status(400).send('No "question" column found.');
    }

    /* ---------- 3.  If skip=1, return sampled CSV only ---------- */
    if (SKIP_MODEL) {
      const csv = new Parser({ fields: ['question'] })
        .parse(questions.map(q => ({ question: q })));
      res.set('Content-Type',        'text/csv')
         .set('Content-Disposition', 'attachment; filename="sampled_questions.csv"')
         .send(csv);
      return;
    }

    /* ---------- 4.  Otherwise run debates ---------- */
    const results = [];
    for (const q of questions) {
      const { finalAnswer } = await multiagentDebate(q, 1); // 1-round debate
      results.push({ question: q, debate_answer: finalAnswer });
    }

    /* ---------- 5.  Return CSV with answers ---------- */
    const csv = new Parser({ fields: ['question', 'debate_answer'] }).parse(results);
    res.set('Content-Type',        'text/csv')
       .set('Content-Disposition', 'attachment; filename="debate_results.csv"')
       .send(csv);
  } finally {
    fs.unlink(fullPath, () => {});                // clean temp file
  }
}
/* ========== Start Server ========== */


if (require.main === module) {
  app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
  });
}

module.exports = {
  app,
  clampSampleSize,
  MAX_UPLOAD_BYTES,
  MAX_SAMPLE_ROWS
};
