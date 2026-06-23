/**
 * HFO AUTO-PUBLISH — Add this function to your Google Apps Script project.
 *
 * SETUP (one-time):
 *   1. Paste this function into your existing Apps Script file (below the doGet/doPost code).
 *   2. Set a daily time-driven trigger:
 *        Apps Script Editor → Triggers (clock icon) → Add Trigger
 *        Function: autoPublish
 *        Deployment: Head
 *        Event source: Time-driven → Day timer
 *        Time: choose the hour when your CSV data is typically updated
 *
 * Every day when the trigger fires it reads the CSV, builds the plan from the
 * Director's saved standing orders, and saves it — the unloading page shows it
 * automatically within 3 minutes (or instantly on manual Refresh).
 */

function autoPublish() {
  const props = PropertiesService.getScriptProperties();

  // Read Director's saved standing orders (same key as writeConfig_)
  const cfgJson = props.getProperty('alloc_config');
  if (!cfgJson) {
    Logger.log('autoPublish: no config saved yet — Director must save standing orders first.');
    return;
  }
  const config = JSON.parse(cfgJson);

  // Read levels from CSV — same logic as doGet()
  const file = DriveApp.getFileById(MASTER_CSV_ID);
  const text = file.getBlob().getDataAsString('UTF-8');
  const rows = parseCSV_(text);
  if (rows.length < 2) {
    Logger.log('autoPublish: CSV has no data rows yet — nothing to publish.');
    return;
  }
  const headers = rows[0];
  const lastRow = rows[rows.length - 1];
  const idx = function(h) { return headers.indexOf(h); };

  // Use the date FROM the CSV so it matches what readPlanForDate_ checks
  const asOf = String(lastRow[idx(DATE_COL)] || '').trim().slice(0, 10);
  const levels = {};
  Object.keys(LEVEL_COLS).forEach(function(t) {
    const v = lastRow[idx(LEVEL_COLS[t])];
    levels[t] = (v === '' || v == null) ? null : Number(v);
  });

  if (!asOf) {
    Logger.log('autoPublish: date column missing or empty in CSV.');
    return;
  }

  // Build plan — mirrors buildPlan() in director.html exactly
  const DENSITY = 0.98, TANKER_T = 27, HIGH_ALARM = 0.90, HIGH_HIGH = 0.95;
  const FP = [
    { id:'FP1', name:'Tank 1',   sub:'Power Plant',           tanks:['T1'],      cap:3500,  maxH:9.0,  coupled:false },
    { id:'FP2', name:'Tank 2+3', sub:'Line-1 Kiln · coupled', tanks:['T2','T3'], cap:7000,  maxH:9.0,  coupled:true  },
    { id:'FP4', name:'Tank 4',   sub:'Line-2 Kiln',           tanks:['T4'],      cap:11000, maxH:15.0, coupled:false },
    { id:'FP5', name:'Tank 5',   sub:'Line-1/2 Common',       tanks:['T5'],      cap:10000, maxH:14.3, coupled:false },
  ];

  function repLevel(fp, L) {
    return fp.coupled
      ? ((Number(L.T2) || 0) + (Number(L.T3) || 0)) / 2
      : (Number(L[fp.tanks[0]]) || 0);
  }
  function volAt(fp, lvl)       { return lvl / fp.maxH * fp.cap; }
  function lvlAfter(fp, lvl, n) { return (volAt(fp, lvl) + n * TANKER_T / DENSITY) / fp.cap * fp.maxH; }
  function maxToHA(fp, lvl)     { return Math.max(0, Math.floor((HIGH_ALARM * fp.cap - volAt(fp, lvl)) * DENSITY / TANKER_T)); }

  const items = [];
  FP.forEach(function(fp) {
    const c = config[fp.id];
    if (!c) return;
    const lvl = repLevel(fp, levels);
    if (lvl <= Number(c.min)) {
      var batch = Number(c.batch);
      if (lvlAfter(fp, lvl, batch) > HIGH_HIGH * fp.maxH) { batch = maxToHA(fp, lvl); }
      items.push({ name:fp.name, sub:fp.sub, level:lvl, min:Number(c.min), tankers:batch, priority:Number(c.priority) });
    }
  });
  items.sort(function(a, b) { return a.priority - b.priority; });

  // Save using the same key as writePlan_() so readPlanForDate_() finds it
  const plan = {
    date: asOf,
    publishedAt: new Date().toISOString(),
    autoPublished: true,
    items: items.map(function(i) {
      return { name:i.name, sub:i.sub, tankers:i.tankers, level:i.level, min:i.min };
    })
  };
  props.setProperty('alloc_plan', JSON.stringify(plan));

  Logger.log('autoPublish: done for ' + asOf + ' — ' + items.length + ' tank(s) need refill.');
}
