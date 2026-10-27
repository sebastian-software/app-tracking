export const adminHTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tool usage · app-tracking</title><link rel="stylesheet" href="/admin/style.css"><script src="/admin/app.js" defer></script></head>
<body><a class="skip" href="#main">Skip to content</a>
<header class="masthead"><a class="brand" href="/admin"><span aria-hidden="true" class="mark">▥</span> app-tracking</a><span class="private">Maintainer view</span><button id="signout" hidden>Sign out</button></header>
<main id="main"><section class="intro"><p class="eyebrow">CLI telemetry</p><h1>Tool usage</h1><p>Understand how consenting installations use your tools.</p></section>
<section id="login" class="login" aria-labelledby="access-title"><h2 id="access-title">Maintainer access</h2><p>Use your read-only reporting key. CLI reporting keys do not grant access.</p>
<form id="access" method="post" action="/admin"><label for="key">Maintainer access key</label><div class="key-row"><input id="key" type="password" name="password" autocomplete="current-password" required spellcheck="false"><button type="submit" class="primary">Open statistics</button></div></form>
<p class="muted">Your key stays in this tab until you sign out. Reloading clears access.</p></section>
<section id="workspace" hidden aria-label="Usage statistics">
<form id="filters" class="filters"><label>Tool<select id="tool"><option value="all">All tools</option><option value="palamedes">Palamedes</option><option value="dalo">Dalo</option></select></label>
<label>Context<select id="mode"><option value="local">Local CLI</option><option value="ci">CI · explicit opt-in</option></select></label>
<label>From (UTC)<input id="from" type="date" required></label><label>Through (UTC)<input id="through" type="date" required></label><button class="primary" type="submit">Apply filters</button>
<div class="presets" aria-label="Quick date ranges"><button type="button" data-days="7">7 days</button><button type="button" data-days="30">30 days</button><button type="button" data-days="90">90 days</button></div></form>
<div class="report-heading"><h2 id="period">Usage overview</h2><p id="snapshot" class="muted"></p></div>
<p id="coverage" class="notice" hidden></p>
<div class="metrics"><div><span>Reported invocations</span><strong id="invocations">—</strong></div><div><span>Reporting installations</span><strong id="installations">—</strong></div><div><span>Reporting projects</span><strong id="projects">—</strong></div><div><span>Unknown-project usage</span><strong id="unknown">—</strong></div></div>
<section class="panel trend" aria-labelledby="trend-title"><div class="panel-heading"><h3 id="trend-title">Daily invocations</h3><span class="muted">UTC occurrence day</span></div><div id="chart"></div><p id="empty" class="empty" hidden>No reports have been received for this period.</p></section>
<div class="tables"><section class="panel" aria-labelledby="commands-title"><div class="panel-heading"><h3 id="commands-title">Command usage</h3><span id="command-count" class="muted"></span></div><div class="table-scroll" tabindex="0" role="region" aria-label="Command usage table"><table><thead><tr><th scope="col">Tool / command</th><th scope="col" class="number">Invocations</th></tr></thead><tbody id="commands"></tbody></table></div></section>
<section class="panel" aria-labelledby="versions-title"><div class="panel-heading"><h3 id="versions-title">Version adoption</h3><span id="version-count" class="muted"></span></div><div class="table-scroll" tabindex="0" role="region" aria-label="Version adoption table"><table><thead><tr><th scope="col">Tool / version</th><th scope="col" class="number">Invocations</th></tr></thead><tbody id="versions"></tbody></table></div><p id="truncated" class="muted table-note" hidden>Showing the top 100 versions. Totals include every version.</p></section></div>
<aside class="measurement"><h3>What these numbers mean</h3><p>These are reported invocations, installations, and repository projects from consenting CLI users. They are not counts of people or all users. Local and CI activity are measured separately.</p><p>Project identities are shared across clones and tools. Installation identities are scoped to a tool. Period-wide unique counts are calculated for the whole selected window; daily unique counts must not be added together.</p><p>Recent days can change as delayed batches arrive. Deletion and expiry remove contributions from subsequent queries. Detailed usage is retained for 90 days.</p></aside>
</section><p id="status" role="status" aria-live="polite"></p><button id="retry" hidden>Try again</button></main>
<footer>app-tracking · Private reporting · All dates in UTC</footer></body></html>`;

export const adminCSS = `
:root{color-scheme:light;--ink:#182b39;--muted:#526674;--line:#d6e0e6;--accent:#075c59;--bg:#f4f7f8;--surface:#fff;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:15px;line-height:1.5}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink)}[hidden]{display:none!important}a{color:var(--accent)}button,input,select{font:inherit}button,input,select{border:1px solid #a4b6c0;border-radius:5px;background:white;color:var(--ink);min-height:42px;padding:8px 12px}button{cursor:pointer;font-weight:600}button:hover{background:#e7f0ef}button:disabled{cursor:wait;opacity:.65}button.primary{color:white;background:var(--accent);border-color:var(--accent)}button.primary:hover{background:#044743}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,.table-scroll:focus-visible{outline:3px solid #186df1;outline-offset:3px}input,select{max-width:100%;min-width:0}label{font-size:.85rem;font-weight:600;display:flex;flex-direction:column;gap:6px}.masthead{display:flex;align-items:center;gap:18px;min-height:76px;background:var(--surface);border-bottom:1px solid var(--line);padding:16px max(24px,calc((100vw - 1200px)/2))}.brand{display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--ink);font-weight:750;font-size:1.15rem;letter-spacing:-.035em}.mark{display:grid;place-items:center;color:white;background:var(--accent);border-radius:6px;width:30px;height:30px;font-size:22px}.private{font-size:.78rem;padding:4px 9px;background:#edf3f5;border-radius:4px;color:#405867}.masthead button{margin-left:auto}main{max-width:1248px;padding:38px 24px 24px;margin:auto}.intro{margin-bottom:28px}.eyebrow{text-transform:uppercase;letter-spacing:.13em;font-size:.72rem;font-weight:750;color:var(--accent);margin:0 0 7px}h1{font-size:clamp(2rem,4vw,2.8rem);line-height:1.15;letter-spacing:-.045em;margin:0 0 10px}h2,h3,p{margin-top:0}h2{font-size:1.2rem;letter-spacing:-.02em}h3{font-size:1rem;margin-bottom:0}.intro>p:last-child{color:var(--muted);margin:0}.muted{color:var(--muted);font-size:.84rem}.login{max-width:620px;background:var(--surface);border:1px solid var(--line);padding:28px;border-radius:8px}.login h2{margin-bottom:8px}.key-row{display:flex;gap:10px;margin:8px 0 14px}.key-row input{flex:1;width:200px}.login .muted{margin-bottom:0}.filters{display:flex;flex-wrap:wrap;align-items:end;gap:14px;padding:18px;background:var(--surface);border:1px solid var(--line);border-radius:8px;margin-bottom:28px}.filters label{flex:1;min-width:140px}.presets{display:flex;gap:6px;flex-basis:100%;padding-top:4px}.presets button{min-height:32px;font-size:.8rem;padding:4px 10px;background:#f8fafb}.report-heading{display:flex;justify-content:space-between;align-items:baseline;gap:16px}.report-heading h2{margin-bottom:14px}.report-heading p{margin-bottom:14px}.metrics{display:grid;grid-template-columns:repeat(4,1fr);margin:0 0 28px;background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:24px 0}.metrics>div{padding:0 24px;border-left:1px solid var(--line)}.metrics>div:first-child{border:0}.metrics span{font-size:.82rem;color:var(--muted);display:block;margin-bottom:5px}.metrics strong{display:block;font-variant-numeric:tabular-nums;font-size:clamp(1.55rem,3vw,2.25rem);letter-spacing:-.04em;line-height:1.2}.metrics>div:first-child strong{color:var(--accent)}.panel{border:1px solid var(--line);border-radius:8px;background:var(--surface);overflow:hidden}.panel-heading{padding:18px 22px;display:flex;justify-content:space-between;gap:12px;align-items:baseline}.trend{margin-bottom:24px}#chart{padding:0 22px 12px;min-height:235px}#chart svg{display:block;width:100%;height:220px;overflow:visible}.chart-axis{font:12px system-ui;fill:var(--muted)}.chart-grid{stroke:#e6ecef;stroke-width:1}.chart-line{stroke:var(--accent);stroke-width:2.5;fill:none}.tables{display:grid;grid-template-columns:1fr 1fr;gap:24px}.table-scroll{max-height:350px;overflow:auto}table{border-collapse:collapse;width:100%;font-size:.88rem}th{position:sticky;top:0;background:#f3f7f8;text-align:left;color:var(--muted);font-weight:600;font-size:.75rem}td,th{padding:12px 22px;border-bottom:1px solid #e4ebef}td{overflow-wrap:anywhere}td small{display:block;color:var(--muted);font-size:.73rem}.number{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.table-note{padding:12px 22px;margin:0}.measurement{margin-top:28px;border-top:1px solid var(--line);padding-top:22px;max-width:850px;color:var(--muted);font-size:.85rem}.measurement h3{color:var(--ink);margin-bottom:10px}.measurement p{margin-bottom:8px}.notice{background:#fff4db;color:#67450b;padding:12px 16px;border:1px solid #e2c98e;border-radius:5px;font-size:.86rem}.empty{text-align:center;padding:18px;color:var(--muted)}#status{margin:18px 0 8px;min-height:1.5em;color:var(--muted)}#status.error{color:#a02424}footer{max-width:1248px;margin:auto;padding:0 24px 28px;color:var(--muted);font-size:.75rem}.skip{position:absolute;left:16px;top:-100px;background:white;padding:10px;z-index:10}.skip:focus{top:10px}
@media(max-width:760px){main{padding-top:28px}.metrics{grid-template-columns:1fr 1fr;gap:24px 0}.metrics>div:nth-child(3){border-left:0}.tables{grid-template-columns:1fr}.report-heading{display:block}.filters label{min-width:calc(50% - 14px)}.filters>.primary{width:100%}.key-row{flex-direction:column}.key-row input{width:100%}.private{margin-left:auto}.masthead{flex-wrap:wrap}.masthead button{margin-left:0}.panel-heading{padding:16px}.metrics>div{padding:0 18px}td,th{padding:12px 16px}}
@media(prefers-reduced-motion:no-preference){button{transition:background-color .12s ease}}
`;

export const adminJS = String.raw`
(() => {
  const $ = (id) => document.getElementById(id);
  let token = '', latest, pending;
  const format = (value) => new Intl.NumberFormat('en-US').format(BigInt(value));
  const day = (date) => date.toISOString().slice(0,10);
  const addDay = (value, amount) => { const date = new Date(value + 'T00:00:00Z'); date.setUTCDate(date.getUTCDate() + amount); return day(date); };
  function range(days) { const today = day(new Date()); $('from').value = addDay(today, 1-days); $('through').value = today; }
  function status(message, error = false) { $('status').textContent = message; $('status').classList.toggle('error', error); $('retry').hidden = !error || !token; }
  function clear() {
    latest = undefined;
    for (const name of ['invocations','installations','projects','unknown']) $(name).textContent = '—';
    for (const name of ['chart','commands','versions']) $(name).replaceChildren();
    $('snapshot').textContent = ''; $('command-count').textContent = ''; $('version-count').textContent = '';
    $('coverage').hidden = true; $('empty').hidden = true; $('truncated').hidden = true;
  }
  function signout() { pending?.abort(); token = ''; $('key').value = ''; clear(); $('workspace').hidden = true; $('login').hidden = false; $('signout').hidden = true; status('Signed out.'); $('key').focus(); }
  function rows(id, data, field) {
    $(id).replaceChildren();
    for (const item of data) {
      const tr = document.createElement('tr'), name = document.createElement('td'), number = document.createElement('td');
      name.textContent = item[field]; const tool = document.createElement('small'); tool.textContent = item.tool_id; name.append(tool);
      number.textContent = format(item.invocations); number.className = 'number'; tr.append(name, number); $(id).append(tr);
    }
  }
  function chart(data) {
    $('chart').replaceChildren();
    const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns,'svg');
    const width=Math.max(300,$('chart').clientWidth-44), left=width<600?54:70, plot=width-left-15;
    svg.setAttribute('viewBox','0 0 '+width+' 220'); svg.setAttribute('role','img');
    svg.setAttribute('aria-label','Daily reported invocations. Exact values follow in the accessible table.');
    const peak = data.reduce((value,item) => BigInt(item.invocations) > value ? BigInt(item.invocations) : value, 1n), max=(peak+2n)/3n*3n;
    for (let i=0;i<4;i++) {
      const y=20+i*50, line=document.createElementNS(ns,'line'), text=document.createElementNS(ns,'text');
      for (const [key,value] of Object.entries({x1:left,x2:width-15,y1:y,y2:y,class:'chart-grid'})) line.setAttribute(key,String(value));
      text.setAttribute('x','0'); text.setAttribute('y',String(y+4)); text.setAttribute('class','chart-axis'); text.textContent=format(max*BigInt(3-i)/3n); svg.append(line,text);
    }
    const points=data.map((item,index) => (left+index*plot/Math.max(1,data.length-1))+','+(170-Number(BigInt(item.invocations)*1500n/max)/10)).join(' ');
    const line=document.createElementNS(ns,'polyline'); line.setAttribute('points',points); line.setAttribute('class','chart-line'); svg.append(line);
    for (const index of [...new Set(width<600?[0,data.length-1]:[0,Math.floor((data.length-1)/2),data.length-1])]) {
      if(index<0) continue;
      const text=document.createElementNS(ns,'text'); text.setAttribute('x',String(left+index*plot/Math.max(1,data.length-1))); text.setAttribute('y','204'); text.setAttribute('text-anchor',index===0?'start':index===data.length-1?'end':'middle'); text.setAttribute('class','chart-axis'); text.textContent=data[index].day; svg.append(text);
    }
    $('chart').append(svg);
    const details=document.createElement('details'), summary=document.createElement('summary'), table=document.createElement('table');
    summary.textContent='Daily values'; const head=document.createElement('thead'), header=document.createElement('tr');
    for(const label of ['UTC day','Invocations']) { const th=document.createElement('th'); th.scope='col'; th.textContent=label; header.append(th); } head.append(header); table.append(head);
    const body=document.createElement('tbody');
    for(const item of data) { const tr=document.createElement('tr'); for(const text of [item.day,format(item.invocations)]) {const td=document.createElement('td');td.textContent=text;tr.append(td);} body.append(tr); } table.append(body); details.append(summary,table); $('chart').append(details);
  }
  function render(result) {
    latest=result;
    $('invocations').textContent=format(result.totals.invocations);
    $('installations').textContent=format(result.totals.active_installations);
    $('projects').textContent=format(result.totals.active_projects);
    const total=BigInt(result.totals.invocations), unknown=BigInt(result.totals.unknown_project_invocations);
    $('unknown').textContent=total ? (Number(unknown*1000n/total)/10).toFixed(1)+'%' : '—';
    $('period').textContent=result.period.covered_from+' — '+addDay(result.period.until,-1);
    $('snapshot').textContent='Snapshot '+new Date(result.period.snapshot_at).toLocaleString('en-GB',{timeZone:'UTC'})+' UTC';
    $('coverage').hidden=!result.coverage.clipped;
    $('coverage').textContent='Detailed data before '+result.coverage.retained_from+' has expired. The overview covers only the retained portion of this period.';
    $('empty').hidden=result.coverage.has_observations; chart(result.daily);
    rows('commands',result.commands,'command'); rows('versions',result.versions,'tool_version');
    $('command-count').textContent=result.commands.length+' commands'; $('version-count').textContent=result.versions.length+' versions'; $('truncated').hidden=!result.coverage.versions_truncated;
    status('Loaded. Recent seven days are provisional; today may be partial.');
  }
  async function load() {
    if(!token) return;
    pending?.abort(); const controller=new AbortController(); pending=controller;
    const params=new URLSearchParams({from:$('from').value,until:addDay($('through').value,1),tool:$('tool').value,mode:$('mode').value});
    $('workspace').hidden=false; $('login').hidden=true; $('signout').hidden=false; clear(); status('Loading statistics…');
    $('workspace').setAttribute('aria-busy','true');
    try {
      const response=await fetch('/v1/admin/usage?'+params,{headers:{Authorization:'Bearer '+token},cache:'no-store',credentials:'omit',signal:controller.signal});
      const result=await response.json();
      if(controller.signal.aborted) return;
      if(response.status===401) { signout(); status('The reporting key was not accepted. Check your key and try again.',true); return; }
      if(!response.ok) throw new Error(response.status===422?'This period is outside the 90-day detail window. Choose a more recent period.':response.status===400?'Choose a valid date range of at most 90 days.':'Statistics are unavailable. No zero values have been substituted.');
      render(result); $('key').value='';
    } catch(error) { if(!controller.signal.aborted) status(error.message==='Failed to fetch'?'Statistics are unavailable. Try again.':error.message,true); }
    finally { if(pending===controller) $('workspace').removeAttribute('aria-busy'); }
  }
  $('access').addEventListener('submit',(event)=>{event.preventDefault();token=$('key').value.trim();load();});
  $('filters').addEventListener('submit',(event)=>{event.preventDefault();load();});
  for(const button of document.querySelectorAll('[data-days]')) button.addEventListener('click',()=>{range(Number(button.dataset.days));load();});
  let resizeFrame; window.addEventListener('resize',()=>{cancelAnimationFrame(resizeFrame);resizeFrame=requestAnimationFrame(()=>{if(latest)chart(latest.daily);});});
  $('signout').addEventListener('click',signout); $('retry').addEventListener('click',load); range(30);
})();
`;
