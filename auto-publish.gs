/**
 * HFO AUTO-PUBLISH — Add this function to your Google Apps Script project.
 *
 * SETUP (one-time):
 *   1. Paste this function into your Apps Script editor.
 *   2. Set a daily time-driven trigger:
 *        Apps Script Editor → Triggers (clock icon) → Add Trigger
 *        Function: autoPublish
 *        Deployment: Head
 *        Event source: Time-driven → Day timer
 *        Time: choose the hour when your tank level data is typically available
 *
 * That's it. Every day when the trigger fires:
 *   - It reads the current levels (same as your doGet handler)
 *   - It reads the Director's saved standing orders (config)
 *   - It builds the allocation plan using the same logic as director.html
 *   - It saves the plan as the published plan (visible to the unloading team immediately)
 *
 * The Plant Director only needs to open director.html when they want to
 * change a minimum level, batch size, or priority — not every day.
 *
 * The Director can still use "Force-publish now" in director.html for
 * mid-day overrides; those plans are stored with manual:true instead of
 * autoPublished:true so the UI can distinguish them.
 */

function autoPublish() {
  const props = PropertiesService.getScriptProperties();

  // Get Director's saved standing orders
  const cfgJson = props.getProperty('hfo_config');
  if (!cfgJson) {
    Logger.log('autoPublish: no config saved yet — nothing to do.');
    return;
  }
  const config = JSON.parse(cfgJson);

  // ─── GET CURRENT LEVELS ────────────────────────────────────────────────────
  // Replace the line below with your existing call that returns tank levels.
  // It must return an object like: { T1: 5.2, T2: 3.1, T3: 3.0, T4: 7.8, T5: 6.5 }
  const levels = getLevelsFromSheet(); // ← adjust to match your existing code
  // ──────────────────────────────────────────────────────────────────────────

  const asOf = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');

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

  // Save as published plan
  const plan = {
    date: asOf,
    publishedAt: new Date().toISOString(),
    autoPublished: true,
    items: items.map(function(i) {
      return { name:i.name, sub:i.sub, tankers:i.tankers, level:i.level, min:i.min };
    })
  };
  props.setProperty('hfo_plan', JSON.stringify(plan));

  Logger.log('autoPublish: done for ' + asOf + ' — ' + items.length + ' tank(s) need refill.');
}
