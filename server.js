'use strict';

require('dotenv').config();
const path = require('path');
const express = require('express');
const { initDb } = require('./src/db');
const { setMasterKey } = require('./src/vault');
const { rescheduleAll } = require('./src/scheduler');

const PORT = process.env.APP_PORT || 3000;
const DB_PATH = process.env.DB_PATH || './data/automation.db';

// Initialize master key for the vault.
setMasterKey(process.env.MASTER_KEY);

// Initialize the database and (re)register scheduled jobs.
initDb(path.resolve(process.cwd(), DB_PATH));
rescheduleAll();

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Basic navigation context for templates.
app.use((req, res, next) => {
  res.locals.active = '';
  next();
});

app.use('/jobs', require('./src/routes/jobs'));
app.use('/secrets', require('./src/routes/secrets'));
app.use('/runs', require('./src/routes/runs'));

app.get('/', (req, res) => {
  const db = require('./src/db').getDb();
  const jobCount = db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n;
  const secretCount = db.prepare('SELECT COUNT(*) AS n FROM secrets').get().n;
  const runCount = db.prepare('SELECT COUNT(*) AS n FROM runs').get().n;
  res.render('dashboard', { jobCount, secretCount, runCount });
});

app.listen(PORT, () => {
  console.log(`Automation tool running at http://localhost:${PORT}`);
});
