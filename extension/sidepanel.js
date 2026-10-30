import {DEFAULT_SETTINGS, validateSettings, permissionPattern, requestAnswer, safeError} from './core.mjs';
import * as bankData from './bank.mjs';

const $ = id => document.getElementById(id);
let settings = {...DEFAULT_SETTINGS};
let bound = null;
let watching = false;
let current = null;
let imageData = null;
let imageManual = false;
let edited = false;
let pickingRegion = false;
let pickerState = {};
let pickerRequest = 0;
let controller = null;
let generation = 0;
let scheduleTimer;
let lastAnswer = null;
let inputCompleteness = null;
let questionOverview = null;
const questionProgress = new Map();

function progressCounts() {
  const entries=[...questionProgress.values()];
  return {seen:entries.length,answered:entries.filter(item=>item.answered).length,
    filled:entries.filter(item=>item.filled).length};
}
function renderOverview() {
  const items=questionOverview?.items || [],counts=progressCounts();
  $('overviewSummary').textContent=questionOverview?`当前已加载内容中识别到 ${items.length} 道题`:'连接后自动扫描已加载题目';
  $('overviewProgress').textContent=`本次已解答 ${counts.answered} 题 · 已自动填写 ${counts.filled} 题`;
  $('overviewHint').textContent=!watching && questionOverview?'读取已暂停，以上保留本次进度；重新连接后开始新的统计。'
    :questionOverview?.mode==='paged'?`分页题只统计当前已加载内容；本次累计识别到 ${counts.seen} 道题，整卷总数未知。切题后会重新扫描。`
    :questionOverview && !items.length?'暂未识别到可填写题块；仍可使用选区或截图读取。扫描数量不代表题目信息完整。'
    :'仅统计已加载且可识别的题块，可能还有未加载或未识别题目；执行时逐题重新读取。';
  $('overviewListLabel').textContent=`查看已识别题目（${items.length}）`;
  const list=$('overviewList'),scroll=list.scrollTop;list.replaceChildren();
  for(const item of items) {
    const row=document.createElement('li'),title=document.createElement('span'),state=document.createElement('span');
    const progress=questionProgress.get(item.key),active=item.key===questionOverview.currentKey;
    row.dataset.questionKey=item.key;if(active)row.setAttribute('aria-current','true');
    title.textContent=item.preview;
    const type=item.type==='blank'?`填空 · ${item.count} 空`:item.type==='multiple'?'多选':item.type==='single'?'单选 / 判断':'选择题';
    state.className='overview-state';state.textContent=`${active?'当前题 · ':''}${type} · ${progress?.filled?'已自动填写':progress?.answered?'已解答':'待解答'}`;
    row.append(title,state);list.append(row);
  }
  list.scrollTop=scroll;
}
function acceptOverview(snapshot) {
  if(snapshot.manualRegion) {
    if(questionOverview)questionOverview={...questionOverview,currentKey:''};
  } else if(snapshot.questionOverview?.scope==='loaded-recognized' && Array.isArray(snapshot.questionOverview.items)) {
    questionOverview={...snapshot.questionOverview,
      mode:snapshot.questionOverview.mode==='paged' || questionOverview?.mode==='paged'?'paged':'loaded'};
    for(const item of questionOverview.items) if(!questionProgress.has(item.key))questionProgress.set(item.key,{answered:false,filled:false});
  }
  renderOverview();
}
function markQuestionProgress(stage,answer=null) {
  if(!current?.questionKey || current.manualRegion || answer?.inputComplete===false || answer?.questions?.length)return;
  if(stage==='answered' && !String(answer?.answer || '').trim() && !answer?.blankAnswers?.length)return;
  const progress=questionProgress.get(current.questionKey) || {answered:false,filled:false};
  progress.answered=true;if(stage==='filled')progress.filled=true;
  questionProgress.set(current.questionKey,progress);renderOverview();
}
function resetQuestionProgress() {
  questionOverview=null;questionProgress.clear();renderOverview();
}
let bank = new Map();
let siteProfiles = {};
let autoAdapters = {};
let lastAdaptation = null;
const adaptationAttempts = new Set();
let bankWrites = Promise.resolve();
const selectedRecordKeys = new Set();
const recordBoxes = new Map();
let bankConfirming = false;
const profileFields=['question','stem','option','selected','next','type'];
const stateNames={pending:'待核验',verified:'已确认正确',conflict:'答案冲突',invalid:'已标记错误'};
const sourceNames={model:'模型生成',manual:'手动核对',batch:'批量信任确认','import-trusted':'可信文件导入', 'page-confirmed':'网页答案经手动核对',import:'文件导入',legacy:'旧版记录（未核验）'};
function persistBank() {
  bankWrites=bankWrites.catch(()=>{}).then(()=>chrome.storage.local.set({bank:bankData.serialize(bank)}));
  return bankWrites;
}
function showRecord(key=$('recordSelect').value) {
  const entry=bank.get(key);
  $('recordQuestion').value=entry?.question || '';
  $('recordAnswer').value=entry?.answer || '';
  $('recordExplanation').value=entry?.explanation || '';
  $('recordNote').value='';
  $('recordMeta').textContent=entry?`${stateNames[entry.status]} · ${sourceNames[entry.source] || entry.source}${entry.model?' · '+entry.model:''} · 复用 ${entry.hits} 次${entry.hasVisual?' · 图片题仅留作记录，不自动复用':''}`:'选择一条记录进行核对或纠错。';
  $('recordHistory').textContent=entry?.history.map(h=>`${new Date(h.at).toLocaleString()} · ${stateNames[h.status] || h.status} · ${sourceNames[h.source] || h.source}\n${h.answerTexts?.join('；') || ''}\n${h.note || ''}`).join('\n\n') || '暂无修改记录。';
  for(const id of ['confirmRecord','rejectRecord','deleteRecord']) $(id).disabled=!entry || bankConfirming;
}
function filteredRecords() {
  const filter=$('recordFilter').value || 'all';
  return [...bank.values()].filter(entry=>filter==='all' || entry.status===filter);
}
function selectedRecords() {
  return filteredRecords().filter(entry=>selectedRecordKeys.has(entry.key));
}
function updateSelectionControls() {
  const entries=filteredRecords();const visibleKeys=new Set(entries.map(entry=>entry.key));
  for(const key of selectedRecordKeys) if(!visibleKeys.has(key)) selectedRecordKeys.delete(key);
  const count=selectedRecords().length;
  $('confirmFiltered').textContent=`批量保存并确认选中的 ${count} 题`;
  $('confirmFiltered').disabled=count===0 || bankConfirming;
  $('selectionSummary').textContent=`当前列表 ${entries.length} 题，已勾选 ${count} 题。未勾选的题保持原状态。`;
  $('selectAllRecords').textContent=`全选当前列表（${entries.length} 题）`;
  $('selectAllRecords').disabled=!entries.length || bankConfirming;
  $('clearRecordSelection').disabled=!count || bankConfirming;
  for(const id of ['recordFilter','recordSelect','importBank','trustImport']) $(id).disabled=bankConfirming;
  for(const [key,box] of recordBoxes) {box.checked=selectedRecordKeys.has(key);box.disabled=bankConfirming;}
}
function renderBank(selected=$('recordSelect').value) {
  const counts={pending:0,verified:0,conflict:0,invalid:0};for(const entry of bank.values()) counts[entry.status]++;
  $('bankSummary').textContent=`${bank.size} 条记录 · 已确认 ${counts.verified} · 待核验 ${counts.pending} · 冲突 ${counts.conflict} · 已禁用 ${counts.invalid}`;
  const entries=filteredRecords().sort((a,b)=>b.updatedAt-a.updatedAt);
  $('bulkConfirmHint').textContent='只处理上方勾选的题。切换筛选会清空勾选。采用各记录已保存的答案；编辑框的修改请先单独保存。';
  const choices=$('recordChoices');const scroll=choices.scrollTop || 0;choices.replaceChildren();recordBoxes.clear();
  for(const [index,entry] of entries.entries()) {
    const label=document.createElement('label');label.className='record-pick check-row';
    const box=document.createElement('input');box.type='checkbox';box.value=entry.key;
    box.setAttribute('aria-label',`选择第 ${index+1} 题：${entry.stem.slice(0,90)}`);
    box.addEventListener('change',()=>{
      if(bankConfirming || !bank.has(entry.key)) return;
      if(box.checked) selectedRecordKeys.add(entry.key);else selectedRecordKeys.delete(entry.key);
      updateSelectionControls();
    });
    const text=document.createElement('span');text.textContent=`${index+1}. [${stateNames[entry.status]}] ${entry.stem.slice(0,120)} · 已存答案：${entry.answer}`;
    label.append(box,text);choices.append(label);recordBoxes.set(entry.key,box);
  }
  if(!entries.length) {const empty=document.createElement('p');empty.className='hint';empty.textContent='当前筛选下没有记录。';choices.append(empty);}
  choices.scrollTop=scroll;updateSelectionControls();
  const select=$('recordSelect');select.replaceChildren();
  for(const entry of entries) {
    const option=document.createElement('option');option.value=entry.key;option.textContent=`[${stateNames[entry.status]}] ${entry.stem.slice(0,75)}`;select.append(option);
  }
  select.value=entries.some(entry=>entry.key===selected)?selected:entries[0]?.key || '';
  showRecord(select.value);
}
function fillProfile() {
  const value=bound?siteProfiles[bound.origin] || {}:{};
  for(const key of profileFields) $('profile_'+key).value=value[key] || '';
  $('profileSite').textContent=bound?`当前网站：${bound.origin}`:'先连接一个答题页面，再保存此网站的适配。';
}
async function applySiteProfile() {
  const response=await send('QH_PROFILE',{profile:siteProfiles[bound.origin] || {}});
  if(!response?.ok) throw new Error('网页仍在使用旧版脚本，请重新加载扩展，再刷新答题网页后开始。');
  const learned=await send('QH_LEARNED_RULES',{rules:settings.autoAdapt!==false?autoAdapters[bound.origin] || []:[]});
  if(!learned?.ok && Object.keys(autoAdapters).length)throw new Error('自动适配需要新版网页脚本，请刷新测验页面。');
  fillProfile();
}
async function pauseForReview() {
  if(autoFlow) await stop('已暂停自动答题，正在核对本地记录。');
  else invalidate();
}
let port = null;
let reconnectTimer = null;
let closing = false;
let visualPermission = false;
let autoFlow = false;
let autoPaused = false;
let autoCount = 0;
let autoActing = false;
let startingAuto = false;
let readingMoving = false;
let readingMoveSerial = 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const autoActive = () => autoFlow && !autoPaused;
function pauseAuto(message) {
  autoPaused = true;
  $('autoFlowStatus').textContent = message;
  $('autoFlowStatus').hidden = false;
  $('resumeAuto').hidden = false;
  $('copyAutoReport').hidden = false;
  status(message);
  updateButtons();
}
function answerLetters(answer,question='') {
  const letters=bankData.lettersOf(answer);if(letters.length) return letters;
  const text=String(answer || '').trim();
  const truth=/^(?:对|正确|是|true|√)$/iu.test(text)?true:/^(?:错|错误|否|false|×)$/iu.test(text)?false:null;
  if(truth===null) return [];
  const q=bankData.parseQuestion(question);if(!q || q.options.length!==2) return [];
  const wanted=q.options.filter(([,v])=>truth?/^(?:对|正确|是|true|√)$/iu.test(v.trim()):/^(?:错|错误|否|false|×)$/iu.test(v.trim()));
  return wanted.length===1?[wanted[0][0]]:[];
}
function valuesForBlanks(result,count) {
  // Never split punctuation: a single blank can legitimately contain "1,2".
  const values=Array.isArray(result.blankAnswers) && result.blankAnswers.length===count ? result.blankAnswers
    : count===1 && typeof result.answer==='string' ? [result.answer] : null;
  if(!Array.isArray(values) || values.length!==count || values.some(value=>typeof value!=='string' || !value.trim() || value.length>4000)) return null;
  return values.map(value=>value.trim());
}
function showCapturePermission() {
  $('enableCapture').hidden = visualPermission;
  $('captureStatus').textContent = visualPermission
    ? '截图权限已就绪。启用按需识图后，文字题直接读取，需要图像时自动获取整题截图。'
    : '可授权按需截图。Edge 会提示允许访问所有网站；题伴只截取当前绑定的测验页，并把必要截图发给你配置的模型。';
}
function connectPort() {
  if (closing || port) return;
  try {
    const connection = chrome.runtime.connect({name:'QH_PANEL'});
    port = connection;
    connection.onDisconnect.addListener(() => {
      if (port !== connection) return;
      port = null;
      scheduleReconnect();
    });
    if (watching && bound) connection.postMessage({type:'BIND', tabId:bound.id});
  } catch {
    port = null;
    scheduleReconnect();
  }
}
function scheduleReconnect() {
  if (closing || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {reconnectTimer = null; connectPort();}, 300);
}
function postPort(message) {
  if (closing) return;
  if (!port) connectPort();
  try { port?.postMessage(message); }
  catch {
    port = null;
    scheduleReconnect();
  }
}
connectPort();

function status(message, kind='') {
  // Keep a paused automation reason visible when an independent read finishes.
  if (autoFlow && autoPaused && !$('autoFlowStatus').hidden) {
    message = $('autoFlowStatus').textContent;
    kind = 'error';
  }
  $('status').textContent = message;
  $('status').className = `status ${kind}`;
}
function errorMessage(error) { return safeError(error, settings.apiKey); }
function settingsOpen(open) {
  $('settingsSection').hidden = !open;
  $('settingsToggle').setAttribute('aria-expanded', String(open));
}
function fillSettings() {
  for (const key of ['baseUrl','model','apiKey']) $(key).value = settings[key];
  $('vision').checked = settings.vision;
  $('autoAnswer').checked = settings.autoAnswer;
  $('autoAdapt').checked = settings.autoAdapt!==false;
  $('modelLabel').textContent = settings.model || '尚未配置模型';
}
function formSettings() {
  return validateSettings({baseUrl:$('baseUrl').value, model:$('model').value,
    apiKey:$('apiKey').value, vision:$('vision').checked, autoAnswer:$('autoAnswer').checked,autoAdapt:$('autoAdapt').checked});
}
function invalidate() {
  generation++;
  clearTimeout(scheduleTimer);
  if (controller) controller.abort();
  controller = null;
  $('cancel').hidden = true;
  $('solve').textContent = '解答当前题';
  updateButtons();
}
function clearAnswer() {
  lastAnswer = null;
  $('answerContent').hidden = true;
  $('emptyAnswer').hidden = false;
  $('answerBadge').textContent = '待解答';
  $('answerBadge').className = 'tag';
  $('confirmCurrent').hidden=true;
  $('answerSource').textContent='';
  $('regionAnswers').replaceChildren();$('regionAnswers').hidden=true;$('singleAnswer').hidden=false;
}
function showImage(data, manual=false) {
  imageData = data;
  imageManual = manual;
  $('imageBox').hidden = !data;
  if (data) $('questionImage').src = data;
  else $('questionImage').removeAttribute('src');
}
function updateButtons() {
  $('startAuto').disabled = startingAuto || autoActing;
  $('refreshOverview').disabled=!watching || startingAuto || autoActing || readingMoving || pickingRegion || Boolean(controller);
  $('copyAutoReport').hidden = !watching;
  $('autoFlow').checked = autoFlow;
  $('autoMode').textContent = !autoFlow ? '当前模式：只显示参考答案'
    : autoPaused ? '当前模式：自动答题已暂停'
    : watching ? `当前模式：自动答题（解答 → ${current?.answerType==='blank'?'填空':'勾选'} → 下一题）` : '当前模式：自动答题已准备好';
  $('referenceNav').hidden=!watching || autoFlow || pickingRegion || Boolean(current?.manualRegion);
  const order=current?.readingOrder;
  const paged=current?.readingNavigation?.mode==='paged'?current.readingNavigation:null;
  $('readingOrderLabel').textContent=paged?'网页翻题':order?`第 ${order.current} / ${order.total} 题`:'按题序读取';
  $('readPrevious').disabled=!watching || autoFlow || readingMoving || (paged?!paged.previous:order?.current===1);
  $('readNext').disabled=!watching || autoFlow || readingMoving || (paged?!paged.next:Boolean(order && order.current===order.total));
  $('readPrevious').title=paged?.previousReason || '';$('readNext').title=paged?.nextReason || '';
  $('referenceNavHint').textContent=paged?'翻页式：点击上方按钮相当于点击网页的上一题/下一题；新题加载后再读取，仍由你填写和提交。'
    :'顺序跟读：当前题干滚过页面上沿后，先读相邻题。也可用上方按钮定位，始终由你填写答案。';
  for (const id of ['read','pick','reset']) $(id).disabled = !bound || !watching || (id==='pick' && autoActing) || (id==='read' && pickingRegion);
  $('pickerControls').hidden=!pickingRegion;
  $('pickExpand').disabled=!pickingRegion || !pickerState.canExpand;
  $('pickShrink').disabled=!pickingRegion || !pickerState.canShrink;
  $('pickConfirm').disabled=!pickingRegion || !pickerState.hasTarget;
  $('pickCancel').disabled=!pickingRegion;
  $('pickerHint').textContent=pickerState.hasTarget
    ? pickerState.questionCount
      ? `已选 ${pickerState.questionCount} 道题。↑ 增加下一题，到末题时向前增加；↓ 减少一题，最少保留一题。页面会跟随变化位置。${pickerState.change?`${pickerState.change.action==='added'?'刚加入':'刚移出'}：${pickerState.change.text}。`:''}范围约 ${pickerState.width} × ${pickerState.height} 像素。`
      : '当前区域未分出独立题块，不能按题增减。可直接确认区域，或把鼠标移到某一道题重新选择。'
    : '先把鼠标移到网页中的一道题，再按 ↑ 增加一题、↓ 减少一题。Esc 或“取消选择”退出。';
  $('stop').disabled = !watching;
  $('start').disabled = watching;
  $('solve').disabled = readingMoving || pickingRegion || Boolean(controller) || (current?.manualRegion && !imageData) || (!$('questionText').value.trim() && !imageData && !current?.hasVisual);
  if(!controller) $('solve').textContent=current?.manualRegion?'解答所选区域':'解答当前题';
  $('charCount').textContent = `${$('questionText').value.length} 字`;
  $('activityDot').className = watching ? 'dot active' : 'dot';
  $('watchState').textContent = watching ? '已连接 · 仅此标签页' : '尚未连接页面';
}
async function send(type, extra={}) {
  if (!bound) throw new Error('请先在测验网页点击“开始读取此页面”。');
  const value = await chrome.tabs.sendMessage(bound.id, {type,...extra});
  if (value?.error) throw new Error(value.error);
  return value;
}
function renderSnapshot(snapshot, force=false) {
  if (!snapshot || typeof snapshot.fingerprint !== 'string') return;
  acceptOverview(snapshot);
  if (!force && current?.fingerprint === snapshot.fingerprint) {
    current = {...current,...snapshot};
    renderInputSource(snapshot);
    updateButtons();
    return;
  }
  invalidate();
  current = snapshot;
  edited = false;
  showImage(null);
  clearAnswer();
  $('questionText').value = snapshot.text || '';
  renderInputSource(snapshot);
  const warnings = Array.isArray(snapshot.warnings) ? [...snapshot.warnings] : [];
  if (snapshot.hasVisual && !snapshot.manualRegion) warnings.push(snapshot.targetedVisual?'解答时自动获取整道题；超过一屏时会滚动并拼接截图。':'含图片或公式：会附上题目区域截图。请确保题目完整可见。');
  $('questionWarning').textContent = warnings.join(' ');
  $('questionWarning').hidden = !warnings.length;
  updateButtons();
  if(snapshot.manualRegion) {status('正在获取所选区域的完整截图…','busy');return;}
  if (snapshot.confidence === 'low' || snapshot.source === 'page') {
    if (visualPermission && settings.vision && (settings.autoAnswer || autoActive()) && watching) {
      status(snapshot.source === 'screen' ? snapshot.targetedVisual?'准备识别已定位的整道题…':'准备识别当前屏幕中央的题目…' : '文字中缺少题干，准备截取当前测验页，请模型看图识别…');
      scheduleTimer = setTimeout(() => solve(false), 650);
    } else if (snapshot.source === 'screen') status('当前屏幕已就绪。点击“解答当前题”或“重新读取”。');
    else {
      if (autoActive()) pauseAuto('自动答题已暂停：需要先启用截图识别，才能确认完整题目。');
      else status('未能准确定位完整题目。请点“启用截图识别”，或修正文字后手动解答。');
    }
    return;
  }
  if (!snapshot.text?.trim() && !snapshot.hasVisual) {
    status('尚未找到题目，可点击“选择题目区域”。');
    return;
  }
  if ((settings.autoAnswer || autoActive()) && watching) {
    status('已识别新题，准备解答…');
    scheduleTimer = setTimeout(() => solve(false), 650);
  } else status('题目已读取，核对后点击“解答当前题”。');
}
function renderInputSource(snapshot) {
  const names={auto:'网页文字',picked:'已选区域',selection:'选中文字',page:'需要确认',screen:'截图识别'};
  const modes={text:'网页文字','image-text':'文字＋截图',image:'截图识别'};
  $('sourceBadge').textContent=modes[snapshot.inputDecision?.mode] || names[snapshot.source] || '已读取';
  $('sourceBadge').className=snapshot.confidence==='low'?'tag warn':'tag';
}
async function activeMatches() {
  if (!bound) return false;
  const tabs = await chrome.tabs.query({active:true, windowId:bound.windowId});
  return tabs[0]?.id === bound.id;
}
function pageScope(rawUrl) {
  const url=new URL(rawUrl);
  return url.protocol==='file:' ? url.href.split(/[?#]/u)[0] : url.origin;
}
async function activePageTab() {
  const queries = [{active:true,currentWindow:true},{active:true,lastFocusedWindow:true}];
  let found = false;
  for (const query of queries) {
    const tabs = await chrome.tabs.query(query);
    for (const candidate of tabs) {
      if (!candidate.id) continue;
      found = true;
      const tab = candidate.url ? candidate : await chrome.tabs.get(candidate.id).catch(() => candidate);
      if (/^(?:https?:\/\/|file:\/\/\/)/i.test(tab.url || '')) return tab;
    }
  }
  throw new Error(found
    ? '当前标签页不是可读取的网页或本地 HTML 文件，或 Edge 未提供网址。请切回测验页，刷新后重试；浏览器内部页和扩展管理页不能读取。'
    : '没有找到当前网页。请切回测验页，再点击“开始读取此页面”。');
}
async function start() {
  resetQuestionProgress();
  invalidate();
  autoPaused = false;
  $('autoFlowStatus').hidden = true;
  $('resumeAuto').hidden = true;
  autoCount = 0;
  adaptationAttempts.clear();lastAdaptation=null;
  const tab = await activePageTab();
  const pageUrl = new URL(tab.url);
  const localFile = pageUrl.protocol === 'file:';
  if (localFile && !await chrome.extension.isAllowedFileSchemeAccess())
    throw new Error('读取本地 HTML 需要开启文件权限：打开 edge://extensions → 题伴“详细信息” → 开启“允许访问文件 URL”，然后刷新此 HTML 页面并重开侧栏。');
  if (bound && bound.id !== tab.id) await chrome.tabs.sendMessage(bound.id,{type:'QH_STOP'}).catch(()=>{});
  // File URLs have the opaque origin "null". Keep each document's profile
  // separate, ignoring its query/hash, rather than sharing one null profile.
  bound = {id:tab.id, windowId:tab.windowId, origin:pageScope(tab.url)};
  try {
    await chrome.scripting.executeScript({target:{tabId:bound.id}, files:['content.js']});
  } catch (error) {
    const granted = await chrome.permissions.request({origins:[localFile ? 'file:///*' : `${bound.origin}/*`]});
    if (!granted) throw new Error(localFile
      ? '尚未允许题伴读取本地文件。请在扩展详情开启“允许访问文件 URL”，并允许读取本地文件后重试。'
      : '尚未允许题伴读取这个网站。请在 Edge 弹窗中允许当前测验网站，再重试。');
    await chrome.scripting.executeScript({target:{tabId:bound.id}, files:['content.js']});
  }
  watching = true;
  postPort({type:'BIND',tabId:bound.id});
  $('siteLabel').textContent = localFile ? '本地 HTML 文件' : pageUrl.hostname;
  updateButtons();
  await applySiteProfile();
  await send('QH_VISUAL_MODE',{strategy:'auto',enabled:visualPermission && settings.vision});
  renderSnapshot(await send('QH_START',{readingMode:autoFlow?'auto':'reference'}), true);
}
async function stop(message='已暂停，不再自动读取或请求模型。') {
  readingMoveSerial++;readingMoving=false;
  pickingRegion=false;
  invalidate();
  autoFlow = false; autoPaused = false; $('autoFlow').checked = false;
  $('autoFlowStatus').hidden = true;
  $('resumeAuto').hidden = true;
  watching = false;
  if (bound) await send('QH_STOP').catch(()=>{});
  postPort({type:'UNBIND'});
  current = null;
  showImage(null);
  $('questionText').value = '';
  clearAnswer();
  updateButtons();
  renderOverview();
  status(message);
}
let lastScreenCaptureAt=0;
async function captureVisiblePage() {
  const version=generation;
  const wait=550-(Date.now()-lastScreenCaptureAt);
  if(wait>0) await delay(wait);
  if(version!==generation || !await activeMatches()) throw new Error('页面已变化，截图已取消。');
  lastScreenCaptureAt=Date.now();
  return chrome.tabs.captureVisibleTab(bound.windowId,{format:'png'});
}
async function loadCapture(raw) {
  const img=new Image();
  await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(new Error('截图读取失败'));img.src=raw;});
  return img;
}
async function captureTargeted(snapshot) {
  const version=generation;
  let token,complete=false,image,finished,failure='',progress=null;
  try {
    status('正在定位完整题目，必要时自动滚动并分段截图…','busy');
    let tile=await send('QH_CAPTURE',{action:'begin',fingerprint:snapshot.fingerprint});
    token=tile.token;
    const {width,height}=tile.size || {};
    if(!token || !(width>0 && height>0) || height>9000) throw new Error('题目过长或无法确定完整边界，请手动分段查看。');
    const scale=Math.min(1,2400/width,6000/height,Math.sqrt(10000000/(width*height)));
    if(scale<.65) throw new Error('整题截图缩小后文字过小，请调整页面布局或分段人工查看。');
    const canvas=document.createElement('canvas');
    canvas.width=Math.ceil(width*scale);canvas.height=Math.ceil(height*scale);
    const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
    let covered=0;
    for(let index=0;index<24;index++) {
      if(version!==generation || !await activeMatches()) throw new Error('页面已变化，截图已取消。');
      if(tile.offsetY>covered+1) throw new Error('无法完整获取题干或图像，截图存在缺口，请手动调整后重试。');
      const raw=await captureVisiblePage();
      if(version!==generation || !await activeMatches()) throw new Error('页面已变化，截图已取消。');
      await send('QH_CAPTURE',{action:'check',token});
      const img=await loadCapture(raw),r=tile.rect;
      const sx=img.naturalWidth/tile.viewport.width,sy=img.naturalHeight/tile.viewport.height;
      const top=Math.max(covered,tile.offsetY),end=Math.min(height,tile.offsetY+r.height);
      progress={covered,height};
      if(end<=top+1) throw new Error('网页无法继续滚动获取完整题目，请手动调整后重试。');
      ctx.drawImage(img,r.x*sx,(r.y+top-tile.offsetY)*sy,r.width*sx,(end-top)*sy,
        0,top*scale,width*scale,(end-top)*scale);
      covered=end;
      progress={covered,height};
      if(covered>=height-1) {complete=true;break;}
      tile=await send('QH_CAPTURE',{action:'tile',token,offset:Math.max(0,covered-24)});
    }
    if(!complete) throw new Error('题目超过 24 段截图限制，请分段人工查看。');
    image=canvas.toDataURL('image/png');
  } catch(error) {failure=error.message || '截图未完成';throw error;}
  finally {
    if(token) finished=await send('QH_CAPTURE',{action:'end',token,complete,reason:failure,progress}).catch(()=>null);
  }
  if(version!==generation || !await activeMatches()) throw new Error('页面已变化，截图已取消。');
  if(!finished?.snapshot || finished.snapshot.fingerprint!==snapshot.fingerprint)
    throw new Error('截图完成后题目已变化，请重新读取。');
  return {image,snapshot:finished.snapshot,capture:finished.capture};
}
async function capture(snapshot, wholeViewport=false) {
  if (!await activeMatches()) throw new Error('请回到绑定的测验标签页后再截图。');
  const version = generation;
  let raw;
  try { raw = await captureVisiblePage(); }
  catch { throw new Error('截图权限不可用。请点击“启用截图识别”并在 Edge 弹窗中允许，然后重试。'); }
  if (version !== generation || !await activeMatches()) throw new Error('页面已变化，截图已取消。');
  if (wholeViewport) return raw;
  const img = new Image();
  await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(new Error('截图读取失败'));img.src=raw;});
  const viewport = snapshot?.viewport || {width:img.naturalWidth, height:img.naturalHeight};
  const r = wholeViewport ? null : snapshot?.rect;
  if (!r) return raw;
  const sx = img.naturalWidth / viewport.width;
  const sy = img.naturalHeight / viewport.height;
  const x = Math.max(0, Math.round(r.x*sx));
  const y = Math.max(0, Math.round(r.y*sy));
  const w = Math.min(img.naturalWidth-x, Math.round(r.width*sx));
  const h = Math.min(img.naturalHeight-y, Math.round(r.height*sy));
  if (w<8 || h<8) throw new Error('题目不在当前可见区域。请滚动到题目，再重新读取。');
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 2400/Math.max(w,h));
  canvas.width = Math.round(w*scale); canvas.height = Math.round(h*scale);
  canvas.getContext('2d').drawImage(img,x,y,w,h,0,0,canvas.width,canvas.height);
  return canvas.toDataURL('image/png');
}
function renderAnswer(answer, cached=false) {
  markQuestionProgress('answered',answer);
  lastAnswer = answer;
  $('emptyAnswer').hidden = true;
  $('answerContent').hidden = false;
  $('answer').textContent = answer.answer;
  $('explanation').textContent = answer.explanation;
  const multiple=Array.isArray(answer.questions) && answer.questions.length>1;
  $('singleAnswer').hidden=multiple;$('regionAnswers').hidden=!multiple;$('regionAnswers').replaceChildren();
  if(multiple) for(const [index,item] of answer.questions.entries()) {
    const card=document.createElement('section');card.className='region-answer';
    const heading=document.createElement('h3'),stem=document.createElement('p'),value=document.createElement('p'),label=document.createElement('h4'),detail=document.createElement('p');
    heading.textContent=/^第.+题$/u.test(item.number)?item.number:`第${item.number || index+1}题`;
    if(item.uncertain) heading.textContent+=' · 需要核对';
    stem.className='region-stem';stem.textContent=item.recognizedQuestion;
    value.className='answer';value.textContent=item.answer;label.textContent='解题说明';detail.className='explanation';detail.textContent=item.explanation;
    card.append(heading,stem,value,label,detail);$('regionAnswers').append(card);
  }
  $('recognizedText').textContent = answer.recognizedQuestion;
  $('recognizedBox').hidden = !answer.recognizedQuestion;
  if (current?.source === 'screen' && answer.recognizedQuestion) {
    $('questionText').value = answer.recognizedQuestion;
    updateButtons();
  }
  $('answerBadge').textContent = answer.provenance==='verified' ? '已确认题库' : autoActive() ? '直接填写' : answer.uncertain ? '模型标注不确定' : '模型参考';
  $('answerSource').textContent=answer.provenance==='verified'?'来源：已确认的本地题库；按题干与选项内容匹配。':'模型参考答案，仅用于本次答题，不加入题库。';
  $('reviewCurrent').hidden=!answer.bankKey;
  if(current?.manualRegion) $('answerSource').textContent=`手动选区参考答案${answer.questions?.length?`，共 ${answer.questions.length} 题`:''}；按选区顺序展示，由你核对和填写。`;
  if(answer.choiceRepair?.attempted)$('answerSource').textContent+=answer.choiceRepair.formatMatched?' 已按单选题重新审题。':' 已复核 1 次，仍需确认单选答案。';
  if(answer.blankRepair?.attempted) $('answerSource').textContent+=answer.blankRepair.formatMatched?' 已自动补全逐空答案格式。':' 已尝试补全逐空答案，仍需核对。';
  $('confirmCurrent').hidden=!answer.bankKey || bank.get(answer.bankKey)?.status==='verified';
  $('answerBadge').className = answer.uncertain ? 'tag warn' : 'tag';
  if(answer.inputComplete===false) {$('answer').textContent='题目资料不完整，未生成可填写答案';$('answerBadge').textContent='缺少题目资料';}
}
function incompleteInputReason(result) {
  return '题目信息不完整：'+(result.missingInformation || '模型报告缺少作答所需资料。')+' 请补齐后重新解答。';
}
async function ensureInputComplete(phase) {
  if(!bound || !watching || !current)return;
  const check=await send('QH_CHECK_INPUT',{fingerprint:current.fingerprint,phase});
  inputCompleteness=check;
  if(check?.ok===false) {clearAnswer();throw new Error(check.reason || '题目信息不完整，已停止答题。');}
}
async function advanceAutomatically(result, version) {
  if (!autoActive() || version !== generation || autoActing) return;
  autoActing = true;
  updateButtons();
  try { await performAutoStep(result, version); }
  finally {
    autoActing = false;
    // Selection can update a site's saved/progress text. Reconcile it after
    // filling and advancing, rather than cancelling our own action mid-step.
    if (watching && version === generation) {
      try {
        const fresh = await send('QH_SCAN');
        if (version === generation && fresh.fingerprint !== current?.fingerprint) renderSnapshot(fresh, true);
      } catch(error) {
        if (autoActive()) pauseAuto(`自动答题已暂停：${errorMessage(error)}`);
      }
    }
    updateButtons();
  }
}
async function performAutoStep(result, version) {
  if (!autoActive() || version !== generation) return;
  if(result.inputComplete===false) {inputCompleteness={ok:false,status:'incomplete',source:'model',phase:'model',reason:incompleteInputReason(result)};pauseAuto(inputCompleteness.reason);return;}
  try {await ensureInputComplete('before-fill');}catch(error){pauseAuto(errorMessage(error));return;}
  if(!autoActive() || version!==generation)return;
  if(current?.manualRegion || result.questions?.length) {pauseAuto('手动选区仅显示参考答案，请恢复自动识别后再开始自动填写。');return;}
  status('自动答题：答案已生成，正在定位并填写网页题目…','busy');
  if (!await activeMatches()) {pauseAuto('自动答题已暂停：请回到绑定的测验标签页。');return;}
  if (!autoActive() || version !== generation) return;
  // Non-reusable bank entries are skipped by lookupVerified, not a model-answer stop condition.
  const blank=current?.answerType==='blank';
  const letters=blank?[]:answerLetters(result.answer,result.recognizedQuestion || current?.text);
  const values=blank?valuesForBlanks(result,current.blankCount):null;
  if(blank && !values) {pauseAuto(`本题有 ${current.blankCount} 个空，逐空答案数量或格式不匹配，暂时无法定位填写。`);return;}
  if(!blank && current?.choiceType==='single' && letters.length>1) {pauseAuto('单选题需要一个选项字母；模型给出多个字母，无法确定要点击哪一个。');return;}
  if(!blank && !letters.length) {pauseAuto('自动答题已暂停：答案不是明确的选项字母。');return;}
  const question=result.recognizedQuestion || current?.domQuestion || current?.text || '';
  let fingerprint=current.fingerprint;
  let applied=blank ? await send('QH_FILL_BLANKS',{fingerprint,values,question})
    : await send('QH_APPLY_ANSWER',{fingerprint,letters,question,visual:current?.source==='screen' && Boolean(imageData)});
  if (!autoActive() || version !== generation) return;
  if(!blank && !applied?.ok && applied?.adaptable && settings.autoAdapt!==false) {
    applied=await adaptCurrentQuestion({question,letters,fingerprint,version,original:applied});
    if(!autoActive() || version!==generation)return;
    if(applied?.fingerprint)fingerprint=applied.fingerprint;
  }
  if (!applied?.ok) {if(applied?.kind==='incomplete-input'){inputCompleteness=applied.inputCompleteness;clearAnswer();}pauseAuto(applied?.reason || '自动填写失败，请手动处理这一题。');return;}
  autoCount++;
  markQuestionProgress('filled');
  status(`已自动填写第 ${autoCount} 题（${applied.selected}），正在进入下一题…`);
  const next=await send('QH_ADVANCE',{fingerprint});
  if (!autoActive() || version !== generation) return;
  if (!next?.ok) {pauseAuto(next?.reason || '无法安全进入下一题，请手动翻题。');return;}
  if (next.mode === 'end') {pauseAuto('当前页面可识别的题目已处理完，请检查有无遗漏并自行提交。');return;}
  if (!next.baselineKey) {pauseAuto('自动答题已暂停：无法确认当前题的位置。');return;}
  for (let attempt=0;attempt<15;attempt++) {
    if (!autoActive() || version !== generation) return;
    await delay(400);
    if (!autoActive() || version !== generation) return;
    const state=await send('QH_AUTO_STATE');
    if (state.key && state.key !== next.baselineKey) {
      const fresh=await send('QH_SCAN');
      renderSnapshot(fresh,true);
      return;
    }
  }
  pauseAuto('自动答题已暂停：翻题后没有检测到新题，请手动检查页面。');
}
async function adaptCurrentQuestion({question,letters,fingerprint,version,original}) {
  const tabId=bound?.id,origin=bound?.origin,key=tabId+'|'+String(question).replace(/\s+/gu,'').slice(0,4000);
  if(!tabId || adaptationAttempts.has(key) || adaptationAttempts.size>=3)return {ok:false,reason:original.reason+' 本题已尝试适配，或本次已达到3次适配上限，请复制诊断。'};
  adaptationAttempts.add(key);lastAdaptation={status:'preparing',attempts:adaptationAttempts.size};
  let token,owned=false,adaptController,timeout;
  const active=()=>autoActive()&&version===generation&&watching&&bound?.id===tabId&&bound?.origin===origin;
  try {
    const prepared=await send('QH_ADAPT_PREPARE',{question,fingerprint});
    if(!active())return {ok:false};
    if(!prepared?.ok){lastAdaptation.status='unsupported';return {ok:false,reason:prepared?.reason || original.reason};}
    token=prepared.token;lastAdaptation={...lastAdaptation,status:'requesting',candidates:prepared.evidence.candidates.length};
    $('autoFlowStatus').hidden=false;$('autoFlowStatus').textContent='发现未适配的选择题结构，正在请求模型补齐并核验…';status('正在自动适配当前题（最多额外请求1次）…','busy');
    adaptController=controller;if(!adaptController){adaptController=new AbortController();controller=adaptController;owned=true;}
    $('cancel').hidden=false;timeout=setTimeout(()=>adaptController.abort(),45000);
    const decision=await requestAnswer({settings:{...settings},question,scope:'adapter',evidence:prepared.evidence,signal:adaptController.signal});
    if(!active() || !await activeMatches())return {ok:false};
    const activated=await send('QH_ADAPT_ACTIVATE',{token,decision});
    if(!active())return {ok:false};
    if(!activated?.ok)throw new Error(activated?.reason || '适配结构核验失败。');
    current=activated.snapshot;updateButtons();lastAdaptation.status='verifying';
    const applied=await send('QH_APPLY_ANSWER',{question,letters,fingerprint:current.fingerprint,visual:current.source==='screen'&&Boolean(imageData)});
    if(!active())return {ok:false};
    if(!applied?.ok)throw new Error(applied?.reason || '适配后没有确认实际选中。');
    const confirmation=await send('QH_ADAPT_CONFIRM',{token});
    if(!active())return {ok:false};
    if(!confirmation?.ok)throw new Error(confirmation?.reason || '适配结果不能保存。');
    const rules=Array.isArray(autoAdapters[origin])?autoAdapters[origin]:[];
    autoAdapters[origin]=[...rules.filter(rule=>rule.id!==confirmation.rule.id),confirmation.rule].slice(-20);
    if(Object.keys(autoAdapters).length>100)delete autoAdapters[Object.keys(autoAdapters)[0]];
    await chrome.storage.local.set({autoAdapters});
    if(!active())return {ok:false};
    lastAdaptation={...lastAdaptation,status:'saved',ruleId:confirmation.rule.id};
    $('autoFlowStatus').textContent='已完成自动适配并保存，继续当前题。';
    return {...applied,fingerprint:current.fingerprint};
  } catch(error) {
    lastAdaptation={...lastAdaptation,status:'failed',error: error.name==='AbortError'?'适配请求已取消或超时':errorMessage(error)};
    if(!active())return {ok:false};
    return {ok:false,reason:'自动适配未通过：'+lastAdaptation.error+' 请复制诊断。'};
  } finally {
    clearTimeout(timeout);if(owned && controller===adaptController){controller=null;$('cancel').hidden=true;}
    if(token)await chrome.tabs.sendMessage(tabId,{type:'QH_ADAPT_ABORT'}).catch(()=>{});
  }
}
async function solve(manual=true) {
  invalidate();
  clearAnswer();
  inputCompleteness=null;
  const version = generation;
  let timeout;
  let timedOut = false;
  try {
    const config = {...settings};
    if (bound && watching && !await activeMatches()) throw new Error('请回到绑定的测验标签页后再解答。');
    // Re-read immediately, not only when the debounced observer emits. This
    // prevents old question text being paired with a newly rendered image.
    if (bound && watching && current && !current.manualRegion) {
      const fresh = await send('QH_SCAN');
      if (fresh.fingerprint !== current.fingerprint) {
        renderSnapshot(fresh, true);
        status('页面刚刚换题，已更新题目。');
        return;
      }
      current = {...current,...fresh};
      renderInputSource(current);
    }
    await ensureInputComplete('before-request');
    if(version!==generation)return;
    let text = $('questionText').value.trim();
    let image = imageManual?imageData:null;
    const needsPageImage = !edited && (current?.confidence === 'low' || current?.source === 'page' || current?.source === 'screen');
    if ((current?.hasVisual || needsPageImage) && !imageManual) {
      if (!config.vision) throw new Error('请在设置中启用图片识别，或手动补全题干。');
      if (needsPageImage && !visualPermission) throw new Error('只识别到选项。请点击“启用截图识别”并允许 Edge 授权。');
      if (!current?.targetedVisual && !needsPageImage && !manual && (current.warnings || []).some(w => /不完整|超出|不可见|滚动|裁剪/.test(w))) {
        throw new Error('图片题可能未完整显示。请调整页面或缩放后重新读取，再手动解答。');
      }
      if (!current?.targetedVisual && !needsPageImage && !current.rect) throw new Error('无法定位图片题区域，请选择题目区域，或手动截图后解答。');
      if(current?.targetedVisual) {
        const captured=await captureTargeted(current);
        image=captured.image;current={...current,...captured.snapshot,capture:captured.capture};
      } else image = await capture(current, needsPageImage);
      if (version !== generation) return;
      const afterCapture = await send('QH_SCAN');
      if (afterCapture.fingerprint !== current.fingerprint) {renderSnapshot(afterCapture,true);return;}
      showImage(image);
    }
    if (needsPageImage && image) text = current?.domQuestion || '';
    await ensureInputComplete('after-capture');
    if(version!==generation)return;
    if(!image && (current?.warnings || []).some(w=>/题目文字过长|已截取前/.test(w))) {
      inputCompleteness={ok:false,status:'incomplete',source:'page',phase:'before-request',reason:'题目信息不完整：题目文字已被截断，请缩小识别区域或补全题目。'};
      throw new Error(inputCompleteness.reason);
    }
    if (!text && !image) throw new Error('请先读取、粘贴题目或截取题目图片。');
    if (version !== generation) return;
    if(!manual && !current?.manualRegion && current?.answerType!=='blank') {
      const hit=bankData.lookupVerified(bank,text,{hasVisual:Boolean(image || current?.hasVisual)});
      if(hit) {
        hit.entry.hits++;hit.entry.updatedAt=Date.now();
        await persistBank();if(version!==generation) return;
        const {entry,...answer}=hit;renderAnswer(answer,true);renderBank(entry.key);
        if(!autoActive()) status('已复用你确认过的答案，未调用模型。');
        if(autoActive()) await advanceAutomatically(answer,version);
        return;
      }
    }
    validateSettings(config);
    controller = new AbortController();
    const thisController = controller;
    timeout = setTimeout(()=>{timedOut=true;thisController.abort();},90000);
    $('solve').textContent = '正在解答…';
    $('cancel').hidden = false;
    updateButtons();
    status(image ? '正在识别图片并解答…' : '正在生成参考答案…','busy');
    const blankCount=!current?.manualRegion && current?.answerType==='blank'?current.blankCount:0;
    const expectedChoiceType=!current?.manualRegion && !blankCount?(current?.choiceType || ''):'';
    let result = await requestAnswer({settings:config, question:text, image, signal:thisController.signal,expectedChoiceType,directFill:autoActive() && Boolean(blankCount || expectedChoiceType),
      ...(current?.manualRegion?{scope:'region',expectedQuestions:current.regionQuestionCount || 0}:blankCount?{expectedBlanks:blankCount}:{})});
    if (version !== generation) return;
    if (bound && watching && current && !current.manualRegion) {
      if (!await activeMatches()) return;
      const fresh = await send('QH_SCAN');
      if (version !== generation) return;
      if (fresh.fingerprint !== current.fingerprint) {renderSnapshot(fresh,true);return;}
    }
    if(blankCount) {
      const values=valuesForBlanks(result,blankCount);
      if(values)result={...result,answer:values.join('；'),blankAnswers:values};
    }
    // Model answers are transient; the bank is populated only by file import.
    renderAnswer(result);
    if(result.inputComplete===false) {
      inputCompleteness={ok:false,status:'incomplete',source:'model',phase:'model',reason:incompleteInputReason(result)};
      if(autoActive())pauseAuto(inputCompleteness.reason);else status(inputCompleteness.reason);
      return;
    }
    if (!autoActive()) status(result.uncertain ? '模型提示信息不足或存在不确定性，请核对后再填写。' : '参考答案已就绪，请核对后填写。');
    if (autoActive()) await advanceAutomatically(result,version);
  } catch(error) {
    if (version !== generation) return;
    if (error.name === 'AbortError') {
      if (autoActive()) pauseAuto(timedOut?'自动答题已暂停：模型请求超时。':'自动答题已暂停：本次解答已取消。');
      else status(timedOut?'请求超过 90 秒，已停止。可手动重试。':'已取消本次解答。',timedOut?'error':'');
    }
    else {
      if (autoActive()) pauseAuto(`自动答题已暂停：${errorMessage(error)}`);
      else status(errorMessage(error),'error');
      if (!settings.apiKey) settingsOpen(true);
    }
  } finally {
    clearTimeout(timeout);
    if (version === generation) {
      controller = null;
      $('cancel').hidden = true;
      $('solve').textContent = '解答当前题';
      updateButtons();
    }
  }
}
async function saveSettings(event) {
  event?.preventDefault();
  invalidate();
  const next = formSettings();
  // This permission request is directly descended from the user's Save click.
  const granted = await chrome.permissions.request({origins:[permissionPattern(next.baseUrl)]});
  if (!granted) throw new Error('未获得模型服务地址的访问权限，设置未保存。');
  await chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
  await chrome.storage.local.set({settings:next});
  settings = next;
  clearAnswer(); fillSettings();
  if (watching) renderSnapshot(await send('QH_VISUAL_MODE',{strategy:'auto',enabled:visualPermission && settings.vision}),true);
  $('settingsStatus').textContent = '已保存。可以测试连接，或开始读取测验网页。';
  status('模型设置已保存。');
  return next;
}

function run(action, destination='main') {
  return async event => {
    try { await action(event); }
    catch(error) {
      if (destination==='settings') $('settingsStatus').textContent = errorMessage(error);
      else if(destination==='profile') $('profileStatus').textContent=errorMessage(error);
      else status(errorMessage(error),'error');
    }
  };
}
$('settingsToggle').addEventListener('click',()=>settingsOpen($('settingsSection').hidden));
$('settingsForm').addEventListener('submit',run(saveSettings,'settings'));
$('testConnection').addEventListener('click',run(async()=>{
  const next = await saveSettings();
  const version = generation;
  $('testConnection').disabled = true;
  $('settingsStatus').textContent = '正在向模型发送一条连接测试请求…';
  const testController = new AbortController();
  controller = testController;
  const timer = setTimeout(()=>testController.abort(),30000);
  try {
    await requestAnswer({settings:next,question:'连接测试：1+1等于几？请用规定的 JSON 格式回答。',signal:testController.signal});
    if (version===generation) $('settingsStatus').textContent = '连接成功，模型可以正常回答。';
  } catch(error) {
    if (version===generation) $('settingsStatus').textContent = error.name==='AbortError'?'连接测试超时或已取消。':errorMessage(error);
  } finally {clearTimeout(timer);if(controller===testController)controller=null;$('testConnection').disabled=false;updateButtons();}
},'settings'));
$('clearKey').addEventListener('click',run(async()=>{
  invalidate(); settings.apiKey=''; $('apiKey').value=''; 
  await chrome.storage.local.set({settings});
  $('settingsStatus').textContent='本机密钥已清除。';
},'settings'));
$('enableCapture').addEventListener('click',run(async()=>{
  const granted = await chrome.permissions.request({origins:['<all_urls>']});
  if (!granted) throw new Error('未获得截图权限。你仍可手动输入或粘贴题干。');
  visualPermission = true;
  settings.vision = true;
  $('vision').checked = true;
  await chrome.storage.local.set({settings});
  showCapturePermission();
  status('截图识别已启用。');
  if (watching) renderSnapshot(await send('QH_VISUAL_MODE',{strategy:'auto',enabled:true}),true);
}));
$('start').addEventListener('click',run(start));
$('stop').addEventListener('click',run(()=>stop()));
$('read').addEventListener('click',run(async()=>{
  if(current?.manualRegion) {
    const fresh=await send('QH_SCAN');
    if(!fresh.manualRegion) throw new Error('原选区已消失，请重新选择题目区域。');
    await acceptPickedRegion(fresh);return;
  }
  renderSnapshot(await send('QH_SCAN',{selection:!visualPermission}),true);
  if (visualPermission && settings.vision) await solve(true);
}));
async function moveReference(direction) {
  if(!watching || autoFlow || readingMoving || current?.manualRegion || pickingRegion) return;
  const move=++readingMoveSerial;
  readingMoving=true;invalidate();clearAnswer();showImage(null);
  const version=generation;
  if(current?.readingNavigation?.mode==='paged') status(`正在切换网页的${direction>0?'下一题':'上一题'}，等待新题加载…`,'busy');
  try {
    const snapshot=await send('QH_READ_MOVE',{direction});
    if(move===readingMoveSerial && version===generation && watching && !autoFlow) renderSnapshot(snapshot,true);
  } catch(error) {
    if(move!==readingMoveSerial || version!==generation || !watching) return;
    // A real document navigation can close the old message channel before the
    // tabs.onUpdated handler rebinds the new content script.
    await delay(60);
    if(move!==readingMoveSerial || version!==generation || !watching) return;
    throw error;
  } finally {if(move===readingMoveSerial) {readingMoving=false;updateButtons();}}
}
$('readPrevious').addEventListener('click',run(()=>moveReference(-1)));
$('readNext').addEventListener('click',run(()=>moveReference(1)));
$('reset').addEventListener('click',run(async()=>{pickingRegion=false;renderSnapshot(await send('QH_RESET'),true);}));
$('refreshOverview').addEventListener('click',run(async()=>{
  if(!watching || autoActing || controller || readingMoving || pickingRegion)return;
  renderSnapshot(await send('QH_SCAN'));
}));
async function acceptPickedRegion(snapshot) {
  pickingRegion=false;invalidate();
  renderSnapshot(snapshot,true);
  const version=generation;
  try {
    const captured=await captureTargeted(snapshot);
    if(version!==generation) return;
    current={...snapshot,...captured.snapshot,capture:captured.capture};
    showImage(captured.image,true);updateButtons();
    status('选区截图已更新。将按顺序解答选区内的全部题目。');
    if(settings.autoAnswer && settings.vision) await solve(false);
  } catch(error) {if(version===generation) throw error;}
}
$('pick').addEventListener('click',run(async()=>{
  invalidate();
  const request=++pickerRequest;
  autoFlow=false;autoPaused=false;$('autoFlowStatus').hidden=true;$('resumeAuto').hidden=true;
  pickingRegion=true;pickerState={};updateButtons();
  try {
    await send('QH_READING_MODE',{mode:'reference'});
    if(request!==pickerRequest || !pickingRegion) return;
    const result=await send('QH_PICK');
    if(request===pickerRequest && pickingRegion) {pickerState=result.state || {};updateButtons();}
  }
  catch(error) {if(request===pickerRequest) {pickingRegion=false;updateButtons();}throw error;}
  if(request===pickerRequest && pickingRegion) status('移动到网页中的一道题后，每按 ↑ 增加一题、↓ 减少一题；点击网页或“确认选区”截图。Esc 或“取消选择”退出。');
}));
async function controlPick(action) {
  if(!pickingRegion) return;
  if(action==='cancel') {
    pickerRequest++;pickingRegion=false;updateButtons();
    status('已取消选区，保留当前截图。');
    await send('QH_PICK_CONTROL',{action});return;
  }
  const result=await send('QH_PICK_CONTROL',{action});
  if(!pickingRegion) return;
  pickerState=result.state || {};
  if(pickerState.active===false) pickingRegion=false;
  updateButtons();
  if(action==='cancel' && result.ok) status('已取消选区，保留当前截图。');
  else if(!result.ok) status(result.reason || '选区操作未完成。');
}
for(const [id,action] of [['pickExpand','expand'],['pickShrink','shrink'],['pickConfirm','confirm'],['pickCancel','cancel']]) {
  $(id).addEventListener('click',run(()=>controlPick(action)));
}
// Opening the picker leaves keyboard focus in the side panel in Edge.
// Route these keys to the same picker actions used by the webpage and buttons.
window.addEventListener('keydown',event=>{
  if(!pickingRegion) return;
  const action={Escape:'cancel',ArrowUp:'expand',ArrowDown:'shrink'}[event.key];
  if(!action) return;
  event.preventDefault();event.stopPropagation();event.stopImmediatePropagation();
  run(()=>controlPick(action))();
},true);
$('removeImage').addEventListener('click',()=>{invalidate();showImage(null);clearAnswer();updateButtons();status('已移除截图。含图题自动解答时会重新截取题目区域。');});
$('solve').addEventListener('click',()=>solve(true));
$('cancel').addEventListener('click',()=>{invalidate();if(autoFlow)pauseAuto('已取消并暂停自动答题。');else status('已取消本次解答。');});
$('questionText').addEventListener('input',()=>{
  invalidate();edited=true;clearAnswer();updateButtons();
  if(autoFlow)pauseAuto('已暂停自动答题：题目文字已手动修改。');
  else status('文字已修改，点击“解答当前题”使用修改后的内容。');
});
async function enableAuto(startPage=false) {
  if(current?.manualRegion) throw new Error('当前是手动选区，请先点击“恢复自动”，再开始自动答题。');
  autoFlow=true;
  autoPaused = false;
  $('autoFlowStatus').hidden = true;
  $('resumeAuto').hidden = true;
  $('diagnosticStatus').hidden = true;
  autoCount=0;
  adaptationAttempts.clear();lastAdaptation=null;
  updateButtons();
  if(!settings.autoAnswer){
    settings.autoAnswer=true;$('autoAnswer').checked=true;
    await chrome.storage.local.set({settings});
  }
  status(watching?'自动答题已开启。将逐题填写，异常时暂停；最终提交由你操作。'
    :'自动答题已准备好。点击“开始读取此页面”后将从当前题开始。');
  if(watching) await send('QH_READING_MODE',{mode:'auto'});
  if (startPage && !watching) await start();
  else if(lastAnswer) await advanceAutomatically(lastAnswer,generation);
  else if(current&&!controller) await solve(false);
}
$('startAuto').addEventListener('click',run(async()=>{
  if (startingAuto || autoActing) return;
  startingAuto = true; updateButtons();
  try { await enableAuto(true); }
  catch(error) { pauseAuto(`自动答题启动失败：${errorMessage(error)}`); }
  finally { startingAuto = false; updateButtons(); }
}));
$('autoFlow').addEventListener('change',run(async()=>{
  if ($('autoFlow').checked) {
    try { await enableAuto(); }
    catch(error) { pauseAuto(`自动答题启动失败：${errorMessage(error)}`); }
  } else {
    autoFlow = false; autoPaused = false;
    if(watching) {
      await send('QH_READING_MODE',{mode:'reference'});
      renderSnapshot(await send('QH_SCAN'));
    }
    $('autoFlowStatus').hidden = true;
    $('resumeAuto').hidden = true;
    updateButtons();
    status('已关闭自动填写；题伴仍可显示参考答案。');
  }
}));
$('resumeAuto').addEventListener('click',run(async()=>{
  if (!autoFlow) return;
  autoPaused = false;
  $('autoFlowStatus').hidden = true;
  $('resumeAuto').hidden = true;
  updateButtons();
  status('正在重新检查当前题…');
  if (lastAnswer && lastAnswer.inputComplete!==false && inputCompleteness?.ok!==false) await advanceAutomatically(lastAnswer,generation);
  else if (watching && current && !controller) await solve(false);
}));
$('copyAutoReport').addEventListener('click',run(async()=>{
  const report = await send('QH_DIAGNOSE');
  await navigator.clipboard.writeText(JSON.stringify({version:'1.6.32',fillPolicy:'direct',stemMatchPolicy:'disabled',optionTextMatch:false,inputCompleteness,modelInputComplete:lastAnswer?.inputComplete ?? null,modelUncertain:Boolean(lastAnswer?.uncertain),explanation:lastAnswer?.explanation || '',mode:{enabled:autoFlow,paused:autoPaused},
    reason:$('autoFlowStatus').textContent,answer:lastAnswer?.answer || '',recognizedQuestion:lastAnswer?.recognizedQuestion || '',
    blankAnswers:lastAnswer?.blankAnswers || null,blankRepair:lastAnswer?.blankRepair || null,choiceRepair:lastAnswer?.choiceRepair || null,
    snapshot:current?{source:current.source,fingerprint:current.fingerprint,answerType:current.answerType || 'choice',
      blankCount:current.blankCount || 0,choiceType:current.choiceType || '',targetedVisual:Boolean(current.targetedVisual),domQuestion:current.domQuestion || '',inputDecision:current.inputDecision || null,
      rect:current.rect,viewport:current.viewport,warnings:current.warnings,capture:current.capture || null}:null,
    bank:{mode:'import-only',autoCollect:false,size:bank.size,status:lastAnswer?.bankKey?bank.get(lastAnswer.bankKey)?.status || '':'',source:lastAnswer?.provenance || 'model'},adaptation:lastAdaptation,page:report},null,2));
  $('diagnosticStatus').textContent = '诊断已复制，可粘贴到聊天中排查网页控件。';
  $('diagnosticStatus').hidden = false;
}));
$('autoAnswer').addEventListener('change',run(async()=>{
  settings.autoAnswer=$('autoAnswer').checked;
  await chrome.storage.local.set({settings});
  if(!settings.autoAnswer){invalidate();if(autoFlow)pauseAuto('已关闭自动解答，自动填写也已暂停。');else status('自动解答已关闭，可手动解答当前题。');}
  else if(watching&&current&&!edited&&(visualPermission&&settings.vision || current.confidence!=='low'&&current.source!=='page')) solve(false);
}));
$('autoAdapt').addEventListener('change',run(async()=>{
  settings.autoAdapt=$('autoAdapt').checked;invalidate();
  await chrome.storage.local.set({settings});
  if(watching){await send('QH_ADAPT_ABORT');await send('QH_LEARNED_RULES',{rules:settings.autoAdapt?autoAdapters[bound.origin] || []:[]});renderSnapshot(await send('QH_SCAN'),true);}
  if(autoFlow)pauseAuto(settings.autoAdapt?'已开启自动适配，请确认当前题后继续。':'已关闭自动适配，自动答题已暂停。');
}));
$('copyAnswer').addEventListener('click',run(async()=>{
  if(!lastAnswer) return;
  await navigator.clipboard.writeText(lastAnswer.answer);
  status('答案已复制。');
}));

$('recordFilter').addEventListener('change',()=>{selectedRecordKeys.clear();renderBank();});
$('selectAllRecords').addEventListener('click',()=>{
  if(bankConfirming) return;
  for(const entry of filteredRecords()) selectedRecordKeys.add(entry.key);
  updateSelectionControls();
});
$('clearRecordSelection').addEventListener('click',()=>{
  if(bankConfirming) return;
  selectedRecordKeys.clear();updateSelectionControls();
});
$('recordSelect').addEventListener('change',()=>showRecord());
$('confirmCurrent').addEventListener('click',run(async()=>{
  const key=lastAnswer?.bankKey;const entry=bank.get(key);if(!entry) return;
  await pauseForReview();
  bankData.confirm(bank,key,{answer:entry.answer,note:'用户核对当前答案并确认正确'});
  await persistBank();renderBank(key);
  if(lastAnswer?.bankKey===key) renderAnswer({...lastAnswer,provenance:'verified',uncertain:false,recordStatus:'verified'});
  status('已记为你核验过的正确答案。发现错误时仍可在本地记录中纠正或禁用。');
}));
$('reviewCurrent').addEventListener('click',()=>{
  $('bankDetails').open=true;
  if(lastAnswer?.bankKey){$('recordFilter').value='all';renderBank(lastAnswer.bankKey);}
  $('bankDetails').scrollIntoView({block:'start'});
});
$('confirmRecord').addEventListener('click',run(async()=>{
  const key=$('recordSelect').value;const answer=$('recordAnswer').value;const explanation=$('recordExplanation').value;const note=$('recordNote').value;
  if(!bank.has(key)) return;
  // Validate before stopping the current run.
  const validation=new Map(bank);bankData.confirm(validation,key,{answer,explanation,note});
  await pauseForReview();bankData.confirm(bank,key,{answer,explanation,note});
  await persistBank();renderBank(key);
  if(lastAnswer?.bankKey===key) {lastAnswer=null;clearAnswer();}
  status('已保存并确认正确；以后按选项文字重新映射答案。');
}));
$('confirmFiltered').addEventListener('click',run(async()=>{
  if(bankConfirming) return;
  const keys=selectedRecords().map(entry=>entry.key);
  if(!keys.length) return;
  bankConfirming=true;updateSelectionControls();showRecord();
  try {
    await pauseForReview();const result=bankData.confirmMany(bank,keys);
    await persistBank();
    for(const key of keys) selectedRecordKeys.delete(key);
    if(lastAnswer?.bankKey && keys.includes(lastAnswer.bankKey)) clearAnswer();
    const message=`已批量确认 ${result.confirmed} 条，原已确认 ${result.unchanged} 条，跳过 ${result.skipped} 条无效记录。`;
    $('bankStatus').textContent=message;status(message);
  } finally {bankConfirming=false;renderBank();}
}));
$('rejectRecord').addEventListener('click',run(async()=>{
  const key=$('recordSelect').value;const note=$('recordNote').value || '用户标记此答案错误';
  await pauseForReview();bankData.reject(bank,key,note);await persistBank();renderBank(key);
  if(lastAnswer?.bankKey===key) clearAnswer();
  status('已标记错误并禁用复用。后续模型答案也不能自动把此记录改回已确认。');
}));
$('deleteRecord').addEventListener('click',run(async()=>{
  const key=$('recordSelect').value;await pauseForReview();bank.delete(key);await persistBank();renderBank();
  if(lastAnswer?.bankKey===key) clearAnswer();status('已删除所选记录。');
}));
$('exportBank').addEventListener('click',run(async()=>{
  const blob=new Blob([bankData.serialize(bank)],{type:'application/json'});const url=URL.createObjectURL(blob);
  const link=document.createElement('a');link.href=url;link.download='题伴-答题记录.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  $('bankStatus').textContent='已导出题目、答案和核验历史；文件不包含 API 密钥、Cookie 或截图。';
}));
$('importBank').addEventListener('change',run(async()=>{
  const file=$('importBank').files?.[0];if(!file) return;
  const trust=$('trustImport').checked;
  try {
    if(file.size>5*1024*1024) throw new Error('题库文件超过 5 MB，请拆分后导入。');
    const raw=JSON.parse(await file.text());if(!Array.isArray(raw?.items)) throw new Error('请选择题伴导出的 JSON 记录文件。');
    await pauseForReview();const result=bankData.mergeImport(bank,raw,{trust});await persistBank();selectedRecordKeys.clear();clearAnswer();renderBank();
    $('bankStatus').textContent=trust
      ?`已导入并直接确认 ${result.confirmed} 条（新增 ${result.added}，更新 ${result.updated}）；覆盖 ${result.conflicts} 条不同答案，跳过 ${result.skipped} 条重复、超限或无效记录。匹配的文本题可直接复用。`
      :`新增 ${result.added} 条待核验记录，发现 ${result.conflicts} 条冲突，跳过 ${result.skipped} 条重复、超限或无效记录。`;
  } finally {$('importBank').value='';}
}));
$('saveProfile').addEventListener('click',run(async()=>{
  if(!bound || !watching) throw new Error('请先连接当前答题网页。');
  const next=Object.fromEntries(profileFields.map(key=>[key,$('profile_'+key).value.trim()]));
  const response=await send('QH_PROFILE',{profile:next});if(!response?.ok) throw new Error('网页没有接受适配设置，请重新加载扩展并刷新网页。');
  invalidate();if(autoFlow) pauseAuto('网站适配已修改，请核对识别结果后再继续。');
  siteProfiles[bound.origin]=next;
  if(Object.keys(siteProfiles).length>100) delete siteProfiles[Object.keys(siteProfiles)[0]];
  await chrome.storage.local.set({siteProfiles});
  fillProfile();renderSnapshot(await send('QH_SCAN'),true);
  $('profileStatus').textContent='已保存到当前网站。请先用参考答案模式核对识别，再开始自动答题。';
},'profile'));
$('resetProfile').addEventListener('click',run(async()=>{
  if(!bound || !watching) throw new Error('请先连接当前答题网页。');
  await send('QH_PROFILE',{profile:{}});delete siteProfiles[bound.origin];
  invalidate();if(autoFlow) pauseAuto('已恢复通用适配，请核对后继续。');
  await chrome.storage.local.set({siteProfiles});fillProfile();renderSnapshot(await send('QH_SCAN'),true);
  $('profileStatus').textContent='已恢复通用适配。';
},'profile'));
$('clearAutoAdapters').addEventListener('click',run(async()=>{
  if(!bound)throw new Error('请先连接答题网页。');
  invalidate();delete autoAdapters[bound.origin];await chrome.storage.local.set({autoAdapters});
  if(watching){await send('QH_LEARNED_RULES',{rules:[]});renderSnapshot(await send('QH_SCAN'),true);}
  if(autoFlow)pauseAuto('已清除本网站自动适配，请核对当前题后继续。');
  $('profileStatus').textContent='已清除本网站自动学习的规则；手工适配保留。';
},'profile'));

chrome.runtime.onMessage.addListener((message,sender)=>{
  if(watching && sender.tab?.id===bound?.id && sender.frameId===0) {
    if(message.type==='QH_REGION_PICKED') {run(()=>acceptPickedRegion(message.snapshot))();return;}
    if(message.type==='QH_PICK_STATE') {if(pickingRegion) {pickerState=message.snapshot;updateButtons();}return;}
    if(message.type==='QH_PICK_CANCELLED') {pickingRegion=false;updateButtons();status('已取消选区，保留当前截图。');return;}
    if(pickingRegion || current?.manualRegion) return;
  }
  if(message.type==='QH_QUESTION' && watching && !autoActing && !readingMoving && sender.tab?.id===bound?.id && sender.frameId===0) renderSnapshot(message.snapshot);
});
chrome.tabs.onActivated.addListener(info=>{
  if(watching&&bound&&info.windowId===bound.windowId&&info.tabId!==bound.id) stop('已切换标签页，读取与解答已暂停。回到测验页面后重新开始。');
});
chrome.tabs.onRemoved.addListener(id=>{if(id===bound?.id)stop('测验标签页已关闭。');});
chrome.tabs.onUpdated.addListener(async(id,info,tab)=>{
  if(!watching||id!==bound?.id)return;
  if(info.status==='loading') {
    readingMoveSerial++;readingMoving=false;
    invalidate();current=null;showImage(null);$('questionText').value='';clearAnswer();updateButtons();status('页面加载中，等待题目…');
  }
  if(info.status==='complete') {
    try {
      if(!tab.url || pageScope(tab.url)!==bound.origin) {await stop('网页已切换站点或本地文件，请重新开始读取。');return;}
      await chrome.scripting.executeScript({target:{tabId:id},files:['content.js']});
      await applySiteProfile();
      await send('QH_VISUAL_MODE',{strategy:'auto',enabled:visualPermission && settings.vision});
      renderSnapshot(await send('QH_START',{readingMode:autoFlow?'auto':'reference'}),true);
    } catch {await stop('页面重新加载后需要重新授权，请点击工具栏中的题伴图标再开始。');}
  }
});
window.addEventListener('pagehide',()=>{closing=true;clearTimeout(reconnectTimer);invalidate();if(bound)chrome.tabs.sendMessage(bound.id,{type:'QH_STOP'}).catch(()=>{});});

const saved=await chrome.storage.local.get(['settings','bank','siteProfiles','autoAdapters']);
settings={...DEFAULT_SETTINGS,...saved.settings};
bank=bankData.deserialize(saved.bank);
siteProfiles=saved.siteProfiles && typeof saved.siteProfiles==='object' && !Array.isArray(saved.siteProfiles)?saved.siteProfiles:{};
autoAdapters=saved.autoAdapters && typeof saved.autoAdapters==='object' && !Array.isArray(saved.autoAdapters)?saved.autoAdapters:{};
renderBank();fillProfile();
visualPermission=await chrome.permissions.contains({origins:['<all_urls>']}).catch(()=>false);
showCapturePermission();
fillSettings();updateButtons();
if(!settings.apiKey){settingsOpen(true);status('请填写自己的 API 地址、模型 ID 和 API Key，保存并测试连接。本地演示服务可不填密钥。');}
else status('准备就绪。在测验网页点击“开始读取此页面”。');
