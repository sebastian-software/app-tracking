export const adminHTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tool usage · app-tracking</title><link rel="stylesheet" href="/admin/style.css"><script src="/admin/app.js" defer></script></head>
<body><a class="skip" href="#main">Skip to content</a>
<header class="masthead"><a class="brand" href="/admin"><span aria-hidden="true" class="mark">▥</span> app-tracking</a><span class="private">Maintainer view</span><button id="signout" hidden>Sign out</button></header>
<main id="main"><section class="intro"><p class="eyebrow">Optional tool reports</p><h1>Tool usage</h1><p>Understand how consenting installations use your tools.</p></section>
<section id="login" class="login" aria-labelledby="access-title"><h2 id="access-title">Maintainer access</h2><p>Sign in with your maintainer account to view usage statistics.</p>
<p><a id="signin" class="signin" href="/admin/login">Continue with WorkOS</a></p>
<p class="muted">Only approved maintainers can access this view.</p></section>
<section id="workspace" hidden aria-label="Usage statistics">
<form id="filters" class="filters"><label>Report<select id="source" aria-label="Report"><option value="legacy">Legacy CLI invocations</option><option value="events">Generic events</option><option value="history">Monthly history</option><option value="profiles">Cross-tool profiles</option></select></label>
<label id="history-stream-filter" hidden>History stream<select id="history-stream" aria-label="History stream"><option value="legacy">Legacy CLI invocations</option><option value="events">Generic events</option></select></label>
<label id="metric-filter" hidden>Metric<select id="metric" aria-label="Metric"><option value="cli.invocation">CLI invocations</option><option value="resource.download">Verified resource downloads</option><option value="language.use">Language-use observations</option></select></label>
<label id="tool-filter">Tool<select id="tool" aria-label="Tool"><option value="all">All tools</option><option value="palamedes">Palamedes</option><option value="dalo">Dalo</option><option id="ardo-option" value="ardo" hidden disabled>Ardo</option><option id="ferriki-option" value="ferriki" hidden disabled>Ferriki</option></select></label>
<label id="mode-filter">Context<select id="mode"><option value="local">Local CLI</option><option value="ci">CI · explicit opt-in</option></select></label>
<label class="date-filter">From (UTC)<input id="from" type="date" required></label><label class="date-filter">Through (UTC)<input id="through" type="date" required></label><button class="primary" type="submit">Apply filters</button>
<div id="day-presets" class="presets" aria-label="Quick date ranges"><button type="button" data-days="7">7 days</button><button type="button" data-days="30">30 days</button><button type="button" data-days="90">90 days</button></div><div id="month-presets" class="presets" aria-label="Quick month ranges" hidden><button type="button" data-months="12">12 months</button><button type="button" data-months="24">24 months</button></div></form>
<div class="report-heading"><h2 id="period">Usage overview</h2><p id="snapshot" class="muted"></p></div>
<p id="coverage" class="notice" hidden></p>
<div id="detail-report"><div class="metrics"><div><span id="count-label">Reported invocations</span><strong id="invocations">—</strong></div><div><span>Reporting installations</span><strong id="installations">—</strong></div><div><span>Reporting projects</span><strong id="projects">—</strong></div><div><span>Unknown-project usage</span><strong id="unknown">—</strong></div></div>
<section class="panel trend" aria-labelledby="trend-title"><div class="panel-heading"><h3 id="trend-title">Daily invocations</h3><span class="muted">UTC occurrence day</span></div><div id="chart"></div><p id="empty" class="empty" hidden>No reports have been received for this period.</p></section>
<div class="tables"><section class="panel" aria-labelledby="commands-title"><div class="panel-heading"><h3 id="commands-title">Command usage</h3><span id="command-count" class="muted"></span></div><div id="commands-region" class="table-scroll" tabindex="0" role="region" aria-label="Command usage table"><table><thead><tr><th id="dimension-label" scope="col">Tool / command</th><th scope="col" class="number" data-count-heading>Invocations</th></tr></thead><tbody id="commands"></tbody></table></div></section>
<section class="panel" aria-labelledby="versions-title"><div class="panel-heading"><h3 id="versions-title">Version adoption</h3><span id="version-count" class="muted"></span></div><div class="table-scroll" tabindex="0" role="region" aria-label="Version adoption table"><table><thead><tr><th scope="col">Tool / version</th><th scope="col" class="number" data-count-heading>Invocations</th></tr></thead><tbody id="versions"></tbody></table></div><p id="truncated" class="muted table-note" hidden>Showing the top 100 versions. Totals include every version.</p></section></div>
<section id="systems-panel" class="panel system-panel" aria-labelledby="systems-title" hidden><div class="panel-heading"><h3 id="systems-title">System context</h3><label>Breakdown<select id="system-dimension" aria-label="Breakdown"><option value="os">Operating system</option><option value="os_version">OS version</option><option value="arch">Executable architecture</option><option value="cpu_family">CPU family</option><option value="linux_distribution">Linux distribution</option><option value="linux_distribution_version">Linux distribution version</option><option value="linux_kernel_version">Linux kernel version</option></select></label></div><div class="table-scroll" tabindex="0" role="region" aria-label="System context table"><table><thead><tr><th scope="col">Category</th><th scope="col" class="number" data-count-heading>Observations</th></tr></thead><tbody id="systems"></tbody></table></div><p class="muted table-note">Counts describe observations in the selected metric, not distinct devices. Linux breakdowns cover Linux observations only. Unknown values remain visible.</p><p id="event-truncated" class="muted table-note" hidden>Some breakdowns exceed the limit of 100 rows per field. Totals include all observations.</p><p class="muted table-note">Host, runtime, and separate library versions are not collected by the current event contract. Software versions appear in Version adoption.</p></section>
</div><section id="history-panel" hidden aria-labelledby="history-title"><h3 id="history-title">Monthly summaries</h3><p class="muted">A dash means unavailable data, not zero. Monthly unique counts cannot be summed into annual uniques. Summaries expire 24 months after the end of their occurrence month.</p><div class="panel"><div class="table-scroll" tabindex="0" role="region" aria-label="Monthly history table"><table><thead><tr><th scope="col">Month / tool</th><th scope="col">State</th><th scope="col" class="number">Observations</th><th scope="col" class="number">Monthly installations</th><th scope="col" class="number">Monthly projects</th></tr></thead><tbody id="months"></tbody></table></div></div><section class="panel system-panel" aria-labelledby="history-details-title"><div class="panel-heading"><h3 id="history-details-title">Monthly breakdowns</h3><label>Month details<select id="history-month" aria-label="Month details"></select></label></div><div class="table-scroll" tabindex="0" role="region" aria-label="Monthly breakdowns table"><table><thead><tr><th scope="col">Dimension / category</th><th scope="col" class="number">Observations</th></tr></thead><tbody id="history-breakdowns"></tbody></table></div><p id="history-suppressed" class="muted table-note"></p></section></section>
<section id="profiles-panel" hidden aria-labelledby="profiles-title"><h3 id="profiles-title">Cross-tool overlap</h3><p id="profiles-total" class="muted"></p><div class="panel"><div class="table-scroll" tabindex="0" role="region" aria-label="Profile overlap table"><table><thead><tr><th scope="col">Tools observed in this period</th><th scope="col" class="number">Linked profiles</th></tr></thead><tbody id="profiles"></tbody></table></div></div><p class="muted table-note">Each profile appears once, with the tools that reported eligible activity anywhere in the selected period. These are consenting local profiles, not verified people or physical machines. Tool credentials remain separate. CI is excluded. Linking starts after its own server acknowledgement and never reconstructs earlier overlap.</p></section>
<aside class="measurement"><h3>What these numbers mean</h3><p>These are metric-specific observations, installations, and repository projects from consenting tool users. Legacy CLI invocations and generic events are separate; they are never added together. Downloads, actual language use (including cache hits), and dependency grammar loads answer different questions. Language-use source categories distinguish explicit and dependency loads; the integrating tool defines the exact counting boundary. They are not counts of people or all users. Local and CI activity are measured separately.</p><p>Project identities are shared across clones and tools. Installation identities are scoped to a tool. Period-wide unique counts are calculated for the whole selected window; daily unique counts must not be added together.</p><p>Recent days can change as delayed batches arrive. Deletion and expiry remove contributions from subsequent queries. Detailed usage is retained for 90 days. Separately permitted, screened monthly summaries can be retained for 24 months. A deletion can invalidate a historical month when its source data can no longer be recomputed. No reports does not mean no users; these totals cannot establish adoption outside the reporting population.</p></aside>
</section><p id="status" role="status" aria-live="polite"></p><button id="retry" hidden>Try again</button></main>
<footer>app-tracking · Private reporting · All dates in UTC</footer></body></html>`;

export const adminCSS = `
:root{color-scheme:light;--ink:#182b39;--muted:#526674;--line:#d6e0e6;--accent:#075c59;--bg:#f4f7f8;--surface:#fff;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:15px;line-height:1.5}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink)}[hidden]{display:none!important}a{color:var(--accent)}button,input,select{font:inherit}button,input,select{border:1px solid #a4b6c0;border-radius:5px;background:white;color:var(--ink);min-height:42px;padding:8px 12px}button{cursor:pointer;font-weight:600}button:hover{background:#e7f0ef}button:disabled{cursor:wait;opacity:.65}button.primary{color:white;background:var(--accent);border-color:var(--accent)}button.primary:hover{background:#044743}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,.table-scroll:focus-visible{outline:3px solid #186df1;outline-offset:3px}input,select{max-width:100%;min-width:0}label{font-size:.85rem;font-weight:600;display:flex;flex-direction:column;gap:6px}.masthead{display:flex;align-items:center;gap:18px;min-height:76px;background:var(--surface);border-bottom:1px solid var(--line);padding:16px max(24px,calc((100vw - 1200px)/2))}.brand{display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--ink);font-weight:750;font-size:1.15rem;letter-spacing:-.035em}.mark{display:grid;place-items:center;color:white;background:var(--accent);border-radius:6px;width:30px;height:30px;font-size:22px}.private{font-size:.78rem;padding:4px 9px;background:#edf3f5;border-radius:4px;color:#405867}.masthead button{margin-left:auto}main{max-width:1248px;padding:38px 24px 24px;margin:auto}.intro{margin-bottom:28px}.eyebrow{text-transform:uppercase;letter-spacing:.13em;font-size:.72rem;font-weight:750;color:var(--accent);margin:0 0 7px}h1{font-size:clamp(2rem,4vw,2.8rem);line-height:1.15;letter-spacing:-.045em;margin:0 0 10px}h2,h3,p{margin-top:0}h2{font-size:1.2rem;letter-spacing:-.02em}h3{font-size:1rem;margin-bottom:0}.intro>p:last-child{color:var(--muted);margin:0}.muted{color:var(--muted);font-size:.84rem}.login{max-width:620px;background:var(--surface);border:1px solid var(--line);padding:28px;border-radius:8px}.login h2{margin-bottom:8px}.key-row{display:flex;gap:10px;margin:8px 0 14px}.key-row input{flex:1;width:200px}.login .muted{margin-bottom:0}.filters{display:flex;flex-wrap:wrap;align-items:end;gap:14px;padding:18px;background:var(--surface);border:1px solid var(--line);border-radius:8px;margin-bottom:28px}.filters label{flex:1;min-width:140px}.presets{display:flex;gap:6px;flex-basis:100%;padding-top:4px}.presets button{min-height:32px;font-size:.8rem;padding:4px 10px;background:#f8fafb}.report-heading{display:flex;justify-content:space-between;align-items:baseline;gap:16px}.report-heading h2{margin-bottom:14px}.report-heading p{margin-bottom:14px}.metrics{display:grid;grid-template-columns:repeat(4,1fr);margin:0 0 28px;background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:24px 0}.metrics>div{padding:0 24px;border-left:1px solid var(--line)}.metrics>div:first-child{border:0}.metrics span{font-size:.82rem;color:var(--muted);display:block;margin-bottom:5px}.metrics strong{display:block;font-variant-numeric:tabular-nums;font-size:clamp(1.55rem,3vw,2.25rem);letter-spacing:-.04em;line-height:1.2}.metrics>div:first-child strong{color:var(--accent)}.panel{border:1px solid var(--line);border-radius:8px;background:var(--surface);overflow:hidden}.panel-heading{padding:18px 22px;display:flex;justify-content:space-between;gap:12px;align-items:baseline}.trend{margin-bottom:24px}#metric-filter{min-width:210px}#chart{padding:0 22px 12px;min-height:235px}#chart svg{display:block;width:100%;height:220px;overflow:visible}.chart-axis{font:12px system-ui;fill:var(--muted)}.chart-grid{stroke:#e6ecef;stroke-width:1}.chart-line{stroke:var(--accent);stroke-width:2.5;fill:none}.tables{display:grid;grid-template-columns:1fr 1fr;gap:24px}.table-scroll{max-height:350px;overflow:auto}[aria-label="Monthly history table"] table{min-width:740px}#history-panel td{overflow-wrap:normal}#history-panel td:first-child,#history-panel td:nth-child(2){white-space:nowrap}table{border-collapse:collapse;width:100%;font-size:.88rem}th{position:sticky;top:0;background:#f3f7f8;text-align:left;color:var(--muted);font-weight:600;font-size:.75rem}td,th{padding:12px 22px;border-bottom:1px solid #e4ebef}td{overflow-wrap:anywhere}td small{display:block;color:var(--muted);font-size:.73rem}.number{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.table-note{padding:12px 22px;margin:0}.measurement{margin-top:28px;border-top:1px solid var(--line);padding-top:22px;max-width:850px;color:var(--muted);font-size:.85rem}.measurement h3{color:var(--ink);margin-bottom:10px}.measurement p{margin-bottom:8px}.notice{background:#fff4db;color:#67450b;padding:12px 16px;border:1px solid #e2c98e;border-radius:5px;font-size:.86rem}.empty{text-align:center;padding:18px;color:var(--muted)}#status{margin:18px 0 8px;min-height:1.5em;color:var(--muted)}#status.error{color:#a02424}footer{max-width:1248px;margin:auto;padding:0 24px 28px;color:var(--muted);font-size:.75rem}.skip{position:absolute;left:16px;top:-100px;background:white;padding:10px;z-index:10}.skip:focus{top:10px}
.system-panel{margin-top:24px}.signin{display:inline-flex;align-items:center;min-height:44px;padding:9px 15px;border-radius:5px;background:var(--accent);color:white;text-decoration:none;font-weight:600}.signin:hover{background:#044743}
@media(max-width:760px){main{padding-top:28px}.metrics{grid-template-columns:1fr 1fr;gap:24px 0}.metrics>div:nth-child(3){border-left:0}.tables{grid-template-columns:1fr}.report-heading{display:block}.filters label{min-width:calc(50% - 14px)}.filters .date-filter{flex-basis:100%}.filters>.primary{width:100%}.key-row{flex-direction:column}.key-row input{width:100%}.private{margin-left:auto}.masthead{flex-wrap:wrap}.masthead button{margin-left:0}.panel-heading{padding:16px}.metrics>div{padding:0 18px}td,th{padding:12px 16px}}
@media(prefers-reduced-motion:no-preference){button{transition:background-color .12s ease}}
`;

export const adminJS = String.raw`
(() => {
  const $ = (id) => document.getElementById(id);
  let latest, pending;
  const format = (value) => new Intl.NumberFormat('en-US').format(BigInt(value));
  const day = (date) => date.toISOString().slice(0,10);
  const addDay = (value, amount) => { const date = new Date(value + 'T00:00:00Z'); date.setUTCDate(date.getUTCDate() + amount); return day(date); };
  function range(days) { const today = day(new Date()); $('from').value = addDay(today, 1-days); $('through').value = today; }
  function status(message, error = false) { $('status').textContent = message; $('status').classList.toggle('error', error); $('retry').hidden = !error; }
  function clear() {
    latest = undefined; historyResult = undefined;
    for (const name of ['invocations','installations','projects','unknown']) $(name).textContent = '—';
    for (const name of ['chart','commands','versions','systems','months','history-breakdowns','history-month','profiles']) $(name).replaceChildren();
    $('profiles-total').textContent='';$('history-suppressed').textContent=''; $('snapshot').textContent = ''; $('command-count').textContent = ''; $('version-count').textContent = '';
    $('coverage').hidden = true; $('empty').hidden = true; $('truncated').hidden = true; $('event-truncated').hidden = true;
  }
  async function signout() {
    pending?.abort(); clear(); $('workspace').hidden=true; $('login').hidden=false; $('signout').disabled=true; status('Signing out…');
    try {
      const response=await fetch('/admin/logout',{method:'POST',headers:{'X-App-Tracking-Action':'logout'},credentials:'same-origin',cache:'no-store'});
      if(!response.ok)throw new Error('Sign-out failed');
      const result=await response.json(),target=new URL(result.location);
      if(target.origin!==location.origin && target.origin!=='https://api.workos.com')throw new Error('Invalid logout destination');
      location.assign(target.href);
    }catch { status('Could not sign out. Use Sign out to try again.',true); $('retry').hidden=true; }
    finally { $('signout').disabled=false; }
  }
  function rows(id, data, field) {
    $(id).replaceChildren();
    for (const item of data) {
      const tr = document.createElement('tr'), name = document.createElement('td'), number = document.createElement('td');
      name.textContent = item[field]; const tool = document.createElement('small'); tool.textContent = item.tool_id; name.append(tool);
      number.textContent = format(item.invocations); number.className = 'number'; tr.append(name, number); $(id).append(tr);
    }
  }
  const metricNames = {'cli.invocation':'Invocations','resource.download':'Verified downloads','language.use':'Language-use observations'};
  function countName() { return $('source').value === 'events' ? metricNames[$('metric').value] : 'Invocations'; }
  function contextRows() {
    $('systems').replaceChildren();
    for (const item of latest?.systems || []) {
      if(item.dimension !== $('system-dimension').value) continue;
      const tr=document.createElement('tr'), label=document.createElement('td'), count=document.createElement('td');
      label.textContent=item.value; count.textContent=format(item.count); count.className='number'; tr.append(label,count); $('systems').append(tr);
    }
  }
  let historyResult;
  const shiftMonth=(value,amount)=>{const date=new Date(value+'-01T00:00:00Z');date.setUTCMonth(date.getUTCMonth()+amount);return day(date).slice(0,7);};
  function monthRange(months=12) {const current=day(new Date()).slice(0,7);$('from').value=shiftMonth(current,-months);$('through').value=shiftMonth(current,-1);}
  function historyDetails() {
    $('history-breakdowns').replaceChildren();
    const item=historyResult?.months.find(row=>row.month+':'+row.tool_id===$('history-month').value);
    for(const cell of item?.data?.breakdowns || []) {
      const tr=document.createElement('tr'),label=document.createElement('td'),number=document.createElement('td');label.textContent=cell.dimension+': '+cell.value;number.textContent=format(cell.count);number.className='number';tr.append(label,number);$('history-breakdowns').append(tr);
    }
    $('history-suppressed').textContent=item?.data?.suppressed_breakdowns.length?'Withheld breakdowns: '+item.data.suppressed_breakdowns.join(', ')+'. Small or dominated groups and complementary cells are not displayed.':item?'Only screened monthly breakdowns are shown.':'No finalized monthly breakdown is available.';
  }
  function renderHistory(result) {
    historyResult=result;latest=undefined;$('workspace').hidden=false;$('login').hidden=true;$('signout').hidden=false;
    $('detail-report').hidden=true;$('history-panel').hidden=false;$('profiles-panel').hidden=true;
    $('period').textContent=result.period.from.slice(0,7)+' — '+shiftMonth(result.period.until.slice(0,7),-1);
    $('snapshot').textContent='Snapshot '+new Date(result.period.snapshot_at).toLocaleString('en-GB',{timeZone:'UTC'})+' UTC';
    const names={finalized:'Finalized',suppressed:'Withheld',incomplete:'Incomplete',pending:'Pending',expired:'Expired',disabled:'Disabled'};
    for(const row of result.months){
      const tr=document.createElement('tr'),label=document.createElement('td'),state=document.createElement('td');label.textContent=row.month.slice(0,7);const tool=document.createElement('small');tool.textContent=row.tool_id;label.append(tool);state.textContent=names[row.state];const reason=document.createElement('small');reason.textContent=row.reason.replaceAll('_',' ');state.append(reason);tr.append(label,state);
      for(const field of ['count','monthly_installations','monthly_projects']){const td=document.createElement('td');td.className='number';td.textContent=row.data?format(row.data[field]):'—';tr.append(td);}$('months').append(tr);
      if(row.data){const option=document.createElement('option');option.value=row.month+':'+row.tool_id;option.textContent=row.month.slice(0,7)+' · '+row.tool_id;$('history-month').append(option);}
    }
    if($('history-month').options.length)$('history-month').selectedIndex=$('history-month').options.length-1;
    $('history-month').disabled=!$('history-month').options.length;
    historyDetails();
    status(result.enabled?'Monthly summaries loaded. Gaps and withheld groups are not zeroes.':'Monthly history is not enabled. Detailed reporting remains available.');
  }
  function renderProfiles(result) {
    latest=undefined;historyResult=undefined;$('workspace').hidden=false;$('login').hidden=true;$('signout').hidden=false;
    $('detail-report').hidden=true;$('history-panel').hidden=true;$('profiles-panel').hidden=false;
    $('period').textContent=result.period.from+' — '+addDay(result.period.until,-1);
    $('snapshot').textContent='Snapshot '+new Date(result.period.snapshot_at).toLocaleString('en-GB',{timeZone:'UTC'})+' UTC';
    $('profiles-total').textContent=result.enabled?format(result.totals.profiles)+' linked profiles · '+format(result.totals.installations)+' tool installations · '+format(result.totals.projects)+' reporting repositories':'Profile linking is not enabled.';
    for(const item of result.combinations){const tr=document.createElement('tr'),label=document.createElement('td'),number=document.createElement('td');label.textContent=item.tools.join(' + ');number.className='number';number.textContent=format(item.profiles);tr.append(label,number);$('profiles').append(tr);}
    status(result.enabled?(result.combinations.length?'Overlap loaded for the complete selected period.':'No eligible linked reports are available for this period.'):'Profile linking is not enabled. Independent tool reporting remains available.');
  }
  function sourceControls() {
    const profiles=$('source').value==='profiles';
    const history=$('source').value==='history';
    const events=$('source').value==='events'||(history&&$('history-stream').value==='events');
    $('history-stream-filter').hidden=!history;$('day-presets').hidden=history;$('month-presets').hidden=!history;
    const type=history?'month':'date';
    if($('from').type!==type){$('from').type=type;$('through').type=type;if(history)monthRange();else range(30);}
    $('detail-report').hidden=history||profiles;$('history-panel').hidden=!history;$('profiles-panel').hidden=!profiles;
    $('tool-filter').hidden=profiles;$('mode-filter').hidden=profiles;
    $('metric-filter').hidden=!events; $('metric').disabled=!events;
    for(const id of ['ardo-option','ferriki-option']) { $(id).hidden=!events; $(id).disabled=!events; }
    if(!events && ['ardo','ferriki'].includes($('tool').value)) $('tool').value='all';
    $('systems-panel').hidden=!events;
  }
  function chart(data) {
    $('chart').replaceChildren();
    const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns,'svg');
    const width=Math.max(300,$('chart').clientWidth-44), left=width<600?54:70, plot=width-left-15;
    svg.setAttribute('viewBox','0 0 '+width+' 220'); svg.setAttribute('role','img');
    svg.setAttribute('aria-label','Daily '+countName().toLowerCase()+'. Exact values follow in the accessible table.');
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
    for(const label of ['UTC day',countName()]) { const th=document.createElement('th'); th.scope='col'; th.textContent=label; header.append(th); } head.append(header); table.append(head);
    const body=document.createElement('tbody');
    for(const item of data) { const tr=document.createElement('tr'); for(const text of [item.day,format(item.invocations)]) {const td=document.createElement('td');td.textContent=text;tr.append(td);} body.append(tr); } table.append(body); details.append(summary,table); $('chart').append(details);
  }
  function render(result) {
    $('workspace').hidden=false; $('login').hidden=true; $('signout').hidden=false;
    const events = 'metric' in result.scope;
    if(events) {
      result={...result,totals:{...result.totals,invocations:result.totals.count,unknown_project_invocations:result.totals.unknown_project_count},daily:result.daily.map(row=>({...row,invocations:row.count})),commands:result.dimensions.map(row=>({...row,command:row.dimension+': '+row.value,invocations:row.count})),versions:result.versions.map(row=>({...row,invocations:row.count}))};
    }
    latest=result;historyResult=undefined;$('detail-report').hidden=false;$('history-panel').hidden=true;$('profiles-panel').hidden=true;
    $('count-label').textContent=countName(); $('trend-title').textContent='Daily '+countName().toLowerCase();
    $('commands-title').textContent=events?'Event dimensions':'Command usage';
    $('dimension-label').textContent=events?'Tool / dimension':'Tool / command';
    $('commands-region').setAttribute('aria-label',events?'Event dimensions table':'Command usage table');
    for(const heading of document.querySelectorAll('[data-count-heading]')) heading.textContent=countName();
    $('systems-panel').hidden=!events;
    $('event-truncated').hidden=!events || (!result.coverage.dimensions_truncated && !result.coverage.systems_truncated);
    contextRows();
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
    $('command-count').textContent=result.commands.length+('metric' in result.scope?' dimension values':' commands'); $('version-count').textContent=result.versions.length+' versions'; $('truncated').hidden=!result.coverage.versions_truncated;
    status('Loaded. Recent seven days are provisional; today may be partial.');
  }
  async function load() {
    pending?.abort(); const controller=new AbortController(); pending=controller;
    const profiles=$('source').value==='profiles';
    const history=$('source').value==='history';
    const events=$('source').value==='events'||(history&&$('history-stream').value==='events');
    const params=new URLSearchParams({from:$('from').value,until:history?shiftMonth($('through').value,1)+'-01':addDay($('through').value,1),tool:$('tool').value,mode:$('mode').value});
    if(events)params.set('metric',$('metric').value);
    if(profiles){params.delete('tool');params.delete('mode');}
    if(history){params.set('from',$('from').value+'-01');params.set('until',shiftMonth($('through').value,1)+'-01');params.set('stream',$('history-stream').value);params.set('metric',events?$('metric').value:'cli.invocation');}
    clear(); status('Loading statistics…');
    $('workspace').setAttribute('aria-busy','true');
    try {
      const response=await fetch((profiles?'/v1/admin/profiles?':history?'/v1/admin/history?':events?'/v1/admin/events?':'/v1/admin/usage?')+params,{cache:'no-store',credentials:'same-origin',signal:controller.signal});
      const result=await response.json();
      if(controller.signal.aborted) return;
      if(response.status===401 || response.status===403) {
        $('workspace').hidden=true; $('login').hidden=false; $('signout').hidden=response.status===401;
        const reason=new URLSearchParams(location.search).get('auth');
        status(response.status===403 || reason==='denied'?'Your account does not have maintainer access. Contact your administrator.':reason==='failed'?'Sign-in could not be completed. Try again.':'Sign in to view usage statistics.');
        return;
      }
      if(!response.ok) throw new Error(response.status===422?'This period is outside the 90-day detail window. Choose a more recent period.':response.status===400?(history?'Choose a valid range of at most 24 whole months.':'Choose a valid date range of at most 90 days.'):'Statistics are unavailable. No zero values have been substituted.');
      if(profiles)renderProfiles(result);else if(history)renderHistory(result);else render(result);
    } catch(error) { if(!controller.signal.aborted) status(error.message==='Failed to fetch'?'Statistics are unavailable. Try again.':error.message,true); }
    finally { if(pending===controller) $('workspace').removeAttribute('aria-busy'); }
  }
  $('source').addEventListener('change',()=>{sourceControls();load();});
  $('metric').addEventListener('change',load);
  $('history-stream').addEventListener('change',()=>{sourceControls();load();});
  $('history-month').addEventListener('change',historyDetails);
  for(const button of document.querySelectorAll('[data-months]'))button.addEventListener('click',()=>{monthRange(Number(button.dataset.months));load();});
  $('system-dimension').addEventListener('change',contextRows);
  sourceControls();
  $('filters').addEventListener('submit',(event)=>{event.preventDefault();load();});
  for(const button of document.querySelectorAll('[data-days]')) button.addEventListener('click',()=>{range(Number(button.dataset.days));load();});
  let resizeFrame; window.addEventListener('resize',()=>{cancelAnimationFrame(resizeFrame);resizeFrame=requestAnimationFrame(()=>{if(latest?.daily)chart(latest.daily);});});
  $('signout').addEventListener('click',signout); $('retry').addEventListener('click',load); range(30); load();
  window.addEventListener('pageshow',(event)=>{if(event.persisted){clear();$('workspace').hidden=true;load();}});
})();
`;
