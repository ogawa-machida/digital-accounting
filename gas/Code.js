/**
 * 町内会 会計簿 ― 承認依頼のメール通知（Google Apps Script）
 * 2026.10.03-73 統合版（通知文言・権限表現統一）
 *
 * 通知先：
 *  ・役員／支払者からの通常申請 → 会計担当
 *  ・会計担当本人の立替申請     → 役員
 *  ・利用申請                   → 会計担当
 *
 * 会計簿から受け取る本文は信用せず、Firebase IDトークンで本人確認したうえで
 * Realtime Databaseから伝票・利用者情報を読み直してメール本文を生成する。
 */

const DB_URL = 'https://ogawa-machida-default-rtdb.asia-southeast1.firebasedatabase.app';
const ROOT = 'chokai-kaikei';
const APP_URL = 'https://ogawa-machida.github.io/digital-accounting/';
const MAX_PER_HOUR = 40;

// Claude AI中継
// APIキーはGASのScript Propertiesにだけ保存し、HTML/Firebaseには保存しない。
const CLAUDE_MODEL = 'claude-sonnet-4-6';
const CLAUDE_MAX_IMAGES = 4;
const CLAUDE_MAX_IMAGE_CHARS = 5 * 1024 * 1024; // base64文字列/枚
const CLAUDE_MAX_PER_HOUR = 30;

function doPost(e) {
  let req={}, user=null;
  try {
    const raw=(e&&e.parameter&&e.parameter.payload)?e.parameter.payload:(e&&e.postData?e.postData.contents:'');
    if(!raw)throw new Error('送信内容がありません');
    req=JSON.parse(raw);
    user=verifyUser_(req.idToken);

    let result;
    if(req.action==='claude'){
      if(!claudeRateOk_(user.uid))throw new Error('AIの利用回数が多すぎます。しばらく待ってください');
      result=claude_(user,req);
    }else{
      if(!rateOk_(user.uid))throw new Error('送信回数が多すぎます。しばらく待ってください');
      const appUrl=APP_URL;
      switch(req.action){
        case 'register':result=register_(user);break;
        case 'test':result=test_(user,appUrl);break;
        case 'entry':result=entry_(user,req.entryIds||[],appUrl);break;
        case 'cashFeeReturn':result=cashFeeReturn_(user,req.entryId||'',appUrl);break;
        case 'cashFeeComplete':result=cashFeeComplete_(user,req.entryId||'',appUrl);break;
        case 'settlementConfirm':result=settlementConfirm_(user,req.settlementId||'',appUrl);break;
        case 'member':result=member_(user,appUrl);break;
        default:throw new Error('不明な操作です');
      }
    }
    writeGasResponse_(user,req.requestId,true,result,null);
    return json_({ok:true,accepted:true});
  }catch(err){
    if(user&&req&&req.requestId){
      try{writeGasResponse_(user,req.requestId,false,null,String(err.message||err));}catch(writeErr){
        console.error('GAS応答のFirebase書込失敗: '+String(writeErr.message||writeErr));
      }
    }
    return json_({ok:false,error:String(err.message||err)});
  }
}
function doGet() { return json_({ ok:true, message:'会計簿メール通知は動作しています' }); }

/* ---------- 本人確認 ---------- */
function verifyUser_(idToken) {
  if (!idToken) throw new Error('ログイン情報がありません');
  let seg = String(idToken).split('.')[1] || '';
  seg += '===='.slice(0, (4 - seg.length % 4) % 4);
  const payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(seg)).getDataAsString());
  const uid = payload.user_id || payload.sub;
  if (!uid) throw new Error('ログイン情報が不正です');

  // 実際にRealtime DatabaseへIDトークン付きでアクセスし、ルール側でも検証させる。
  const member = read_('members/' + uid, idToken);
  if (!member) throw new Error('会計簿の利用者として登録されていません');
  return { uid, token:idToken, name:member.name || '', email:member.email || '', role:member.role || '', payerId:member.payerId || '' };
}
function read_(path, token) {
  const res = UrlFetchApp.fetch(DB_URL + '/' + ROOT + '/' + path + '.json?auth=' + encodeURIComponent(token), { muteHttpExceptions:true });
  const code = res.getResponseCode();
  if (code === 401 || code === 403) throw new Error('データベースの読み取りが許可されませんでした');
  if (code !== 200) throw new Error('データベースに接続できません（' + code + '）');
  return JSON.parse(res.getContentText());
}

/* ---------- 通知先 ----------
 * GASのScript Propertiesには、会計担当と役員を役割別に保存する。
 * registerは会計担当または管理者が実行でき、Firebaseの現在のmembersから再作成する。
 */
function register_(user) {
  if (!['treasurer','admin'].includes(user.role)) throw new Error('送信先の登録は会計担当または管理者のみできます');
  const members = read_('members', user.token) || {};
  const values = Object.keys(members).map(k => members[k] || {});
  const treasurers = uniqueEmails_(values.filter(m => m.role === 'treasurer' || m.role === 'admin').map(m => m.email));
  const viewers = uniqueEmails_(values.filter(m => m.role === 'viewer').map(m => m.email));
  const props = PropertiesService.getScriptProperties();
  props.setProperty('TREASURER_RECIPIENTS', JSON.stringify(treasurers));
  props.setProperty('VIEWER_RECIPIENTS', JSON.stringify(viewers));
  // 旧版との互換用。将来削除してもよい。
  props.setProperty('RECIPIENTS', JSON.stringify(treasurers));
  return { ok:true, recipients:treasurers, treasurerRecipients:treasurers, viewerRecipients:viewers };
}
function recipientsByRole_(role) {
  const props = PropertiesService.getScriptProperties();
  const key = role === 'viewer' ? 'VIEWER_RECIPIENTS' : 'TREASURER_RECIPIENTS';
  const saved = JSON.parse(props.getProperty(key) || '[]');
  if (saved.length) return saved;
  if (role === 'treasurer') {
    const legacy = JSON.parse(props.getProperty('RECIPIENTS') || '[]');
    if (legacy.length) return legacy;
    const own = Session.getEffectiveUser().getEmail();
    return own ? [own] : [];
  }
  return [];
}
function uniqueEmails_(list) {
  const seen = {};
  return (list || []).map(x => String(x || '').trim().toLowerCase()).filter(x => x && !seen[x] && (seen[x] = true));
}

/* ---------- 各通知 ---------- */
function test_(user, appUrl) {
  if (!['treasurer','admin'].includes(user.role)) throw new Error('テスト送信は会計担当または管理者のみできます');
  const treasurers = recipientsByRole_('treasurer');
  const viewers = recipientsByRole_('viewer');
  const to = uniqueEmails_(treasurers.concat(viewers));
  if (!to.length) throw new Error('通知先が登録されていません。先に「送信先を更新」してください');
  send_(to, '【会計簿】テスト送信', [
    '通知・AI共通GASの設定ができました。',
    '通常の承認依頼は会計担当・管理者へ通知します。',
    '会計担当・管理者本人の立替申請は、自己承認を避けるため役員へ通知します。',
    '',
    '会計・管理者通知先：' + (treasurers.length ? treasurers.join('、') : '未登録'),
    '役員通知先：' + (viewers.length ? viewers.join('、') : '未登録'),
    '', '送信操作：' + user.name + '（' + user.email + '）'
  ], appUrl, '会計簿を開く');
  return { ok:true, recipients:to, treasurerRecipients:treasurers, viewerRecipients:viewers };
}

function entry_(user, ids, appUrl) {
  if (!['payer','guest','viewer','treasurer'].includes(user.role)) throw new Error('申請の通知を送る権限がありません');
  ids = ids.slice(0, 30);
  const normal = [];
  const treasurerOwn = [];

  ids.forEach(function(id) {
    const ent = read_('entries/' + id, user.token);
    if (!ent || ent.status !== 'submitted') return;

    // 通知を起こした本人が作った伝票だけを対象にする。
    // HTMLからentryIdだけを受け取り、宛先判定はDB上の伝票を見てGAS側で行う。
    if (ent.createdBy && ent.createdBy !== user.uid) return;
    ent.id = id;

    if (ent.selfApprovalRequired) {
      // 自己承認回避フラグは「会計担当が自分で作成した伝票」にだけ認める。
      if (user.role !== 'treasurer' || ent.createdBy !== user.uid) {
        throw new Error('承認先を確認できない伝票があります');
      }
      treasurerOwn.push(ent);
    } else {
      // 会計担当の通常伝票を会計自身へ送ることはしない。
      if (user.role === 'treasurer') throw new Error('会計担当の立替申請には役員承認が必要です');
      normal.push(ent);
    }
  });

  let sent = 0;
  if (normal.length) {
    const to = recipientsByRole_('treasurer');
    if (!to.length) throw new Error('会計担当の通知先が登録されていません');
    sendEntryGroup_(normal, user, to, 'treasurer', appUrl);
    sent += normal.length;
  }
  if (treasurerOwn.length) {
    const to = recipientsByRole_('viewer');
    if (!to.length) throw new Error('役員の通知先が登録されていません。会計簿の設定で役員を登録し、通知先を更新してください');
    sendEntryGroup_(treasurerOwn, user, to, 'viewer', appUrl);
    sent += treasurerOwn.length;
  }
  return { ok:true, sent:sent };
}

function sendEntryGroup_(list, user, to, targetRole, appUrl) {
  const acc = read_('accounts', user.token) || {};
  const methods = read_('methods', user.token) || {};
  const p = (list[0].payerId ? read_('payers/' + list[0].payerId, user.token) : null) || {};
  const who = (p.name || user.name || user.email || '利用者') + (p.post ? '（' + p.post + '）' : '');
  const total = list.reduce((s,e) => s + (Number(e.amount) || 0), 0);
  const isTreasurerOwn = targetRole === 'viewer';

  const lines = [
    isTreasurerOwn
      ? '会計担当の' + who + 'さんから、本人立替分の承認依頼が' + list.length + '件届きました。'
      : who + 'さんから支出の承認依頼が' + list.length + '件届きました。',
    isTreasurerOwn ? '自己承認を避けるため、役員の方が内容を確認して承認してください。' : '会計担当の方が内容を確認してください。',
    ''
  ];

  list.forEach(function(ent) {
    lines.push('■ ' + (ent.voucherNo || '伝票') + '　' + (ent.date || '') + '　' + yen_(ent.amount));
    lines.push('　用途：' + (ent.purpose || '－') + '　／　支払先：' + (ent.payee || '－'));
    lines.push('　科目：' + ((acc[ent.accountId] || {}).name || '－') + '　／　支払方法：' + ((methods[ent.methodId] || {}).name || '－'));
    lines.push('　写真：' + (ent.photoCount ? ent.photoCount + '枚' : (ent.noReceipt ? '領収証なし（' + (ent.noReceiptReason || '') + '）' : 'なし')));
    lines.push('　確認：' + appUrl + '?open=' + encodeURIComponent(ent.id));
    lines.push('');
  });
  lines.push('合計　' + yen_(total));

  const subject = isTreasurerOwn
    ? '【会計簿】会計担当から承認依頼 ' + who + ' ' + list.length + '件 ' + yen_(total)
    : '【会計簿】承認依頼 ' + who + ' ' + list.length + '件 ' + yen_(total);

  const firstUrl = appUrl + '?open=' + encodeURIComponent(list[0].id);
  send_(to, subject, lines, firstUrl, 'この伝票を確認・承認する');
}

function cashFeeReturn_(user, entryId, appUrl) {
  if (user.role !== 'treasurer') throw new Error('現金会費を差し戻せるのは会計担当のみです');
  if (!entryId) throw new Error('差戻し対象が指定されていません');
  const ent = read_('entries/' + entryId, user.token);
  if (!ent || ent.cashFeeRequest !== true || ent.status !== 'returned') throw new Error('差戻し済みの現金会費を確認できません');
  if (ent.cashFeeCheckedBy && ent.cashFeeCheckedBy !== user.uid) throw new Error('差戻しを行った会計担当を確認できません');
  if (!ent.createdBy) throw new Error('申告した班長を確認できません');
  const member = read_('members/' + ent.createdBy, user.token) || {};
  if (member.role !== 'viewer' || member.officerType !== 'leader') throw new Error('申告した班長を確認できません');
  const to = uniqueEmails_([member.email]);
  if (!to.length) throw new Error('班長のメールアドレスが登録されていません');

  const declared = Number(ent.cashFeeDeclaredAmount || ent.amount) || 0;
  const actual = Number(ent.cashFeeActualAmount) || 0;
  const diff = actual - declared;
  const place = (ent.cashFeeBranch || '') + (ent.cashFeeGroup || '');
  const cache = CacheService.getScriptCache();
  const dedupeKey = 'cashFeeReturn_' + entryId + '_' + String(ent.cashFeeCheckedAt || ent.updatedAt || '');
  if (cache.get(dedupeKey)) return { ok:true, sent:0, duplicate:true };

  send_(to, '【デジタル会計】現金会費の確認をお願いします ' + place, [
    (member.name || '班長') + 'さん',
    '',
    '会計担当が現金会費を確認した結果、申告内容が差し戻されました。',
    'デジタル会計を開き、内容を確認して修正・再申告してください。',
    '',
    '支部・班：' + (place || '－'),
    '現金納付世帯数：' + (Number(ent.cashFeeCount) || 0) + '世帯',
    '班長申告額：' + yen_(declared),
    '会計確認額：' + yen_(actual),
    '差額：' + (diff > 0 ? '+' : '') + yen_(diff),
    '差戻し理由：' + (ent.returnReason || '内容を確認してください'),
    '',
    '会計確認者：' + (ent.cashFeeCheckedByName || user.name || '会計担当')
  ], appUrl + '?open=' + encodeURIComponent(entryId), '差戻し内容を確認する');
  cache.put(dedupeKey, '1', 21600);
  return { ok:true, sent:1 };
}


function cashFeeComplete_(user, entryId, appUrl) {
  if (user.role !== 'treasurer') throw new Error('現金会費の受取完了通知を送れるのは会計担当のみです');
  if (!entryId) throw new Error('受取確認対象が指定されていません');
  const ent = read_('entries/' + entryId, user.token);
  if (!ent || ent.cashFeeRequest !== true || ent.status !== 'approved') throw new Error('受取確認済みの現金会費を確認できません');
  if (ent.cashFeeCheckedBy && ent.cashFeeCheckedBy !== user.uid) throw new Error('受取確認を行った会計担当を確認できません');
  if (!ent.createdBy) throw new Error('申告した班長を確認できません');
  const member = read_('members/' + ent.createdBy, user.token) || {};
  if (member.role !== 'viewer' || member.officerType !== 'leader') throw new Error('申告した班長を確認できません');
  const to = uniqueEmails_([member.email]);
  if (!to.length) throw new Error('班長のメールアドレスが登録されていません');

  const declared = Number(ent.cashFeeDeclaredAmount || ent.amount) || 0;
  const actual = Number(ent.cashFeeActualAmount || ent.amount) || 0;
  const diff = actual - declared;
  const place = (ent.cashFeeBranch || '') + (ent.cashFeeGroup || '');
  const cache = CacheService.getScriptCache();
  const dedupeKey = 'cashFeeComplete_' + entryId + '_' + String(ent.cashFeeCheckedAt || ent.approvedAt || ent.updatedAt || '');
  if (cache.get(dedupeKey)) return { ok:true, sent:0, duplicate:true };

  send_(to, '【デジタル会計】現金会費の受取確認が完了しました ' + place, [
    (member.name || '班長') + 'さん',
    '',
    '会計担当による現金会費の受取確認が完了し、会費収入として登録されました。',
    '',
    '支部・班：' + (place || '－'),
    '現金納付世帯数：' + (Number(ent.cashFeeCount) || 0) + '世帯',
    '班長申告額：' + yen_(declared),
    '会計確認額：' + yen_(actual),
    '差額：' + (diff > 0 ? '+' : '') + yen_(diff),
    '',
    '会計確認者：' + (ent.cashFeeCheckedByName || ent.approvedByName || user.name || '会計担当')
  ], appUrl + '?open=' + encodeURIComponent(entryId), '受取確認内容を見る');

  cache.put(dedupeKey, '1', 21600);
  return { ok:true, sent:1 };
}

function settlementConfirm_(user, settlementId, appUrl) {
  if (user.role !== 'treasurer') throw new Error('精算の受取確認依頼を送れるのは会計担当のみです');
  if (!settlementId) throw new Error('精算対象が指定されていません');

  const st = read_('settlements/' + settlementId, user.token);
  if (!st) throw new Error('精算データを確認できません');
  if (st.createdBy && st.createdBy !== user.uid) throw new Error('精算を記録した会計担当を確認できません');
  if (st.payerConfirm) return { ok:true, sent:0, alreadyConfirmed:true };
  if (!st.payerId) throw new Error('精算対象者を確認できません');

  const payer = read_('payers/' + st.payerId, user.token) || {};
  const membersObj = read_('members', user.token) || {};
  const member = Object.keys(membersObj).map(k => ({ uid:k, ...(membersObj[k] || {}) }))
    .find(m => m.payerId === st.payerId) || {};
  const email = member.email || payer.email || '';
  const to = uniqueEmails_([email]);
  if (!to.length) throw new Error('精算対象者のメールアドレスが登録されていません');

  const name = member.name || payer.name || 'ご本人';
  const net = Number(st.net) || 0;
  const amount = Math.abs(net);
  const actionText = net >= 0 ? '会計からの支払いを受け取った' : '会計へ返金した';
  const buttonLabel = net >= 0 ? '受け取りを確認する' : '返金を確認する';
  const cache = CacheService.getScriptCache();
  const dedupeKey = 'settlementConfirm_' + settlementId + '_' + String(st.createdAt || st.date || '');
  if (cache.get(dedupeKey)) return { ok:true, sent:0, duplicate:true };

  send_(to, '【デジタル会計】精算の確認をお願いします ' + (st.no || ''), [
    name + 'さん',
    '',
    '会計担当が精算を記録しました。',
    'デジタル会計を開き、内容をご確認のうえ「' + (net >= 0 ? '受け取りました' : '返金しました') + '」を押してください。',
    '',
    '精算番号：' + (st.no || '－'),
    '精算日：' + (st.date || '－'),
    '金額：' + yen_(amount),
    '精算方法：' + (st.way || '－'),
    '確認内容：' + actionText + 'ことの確認',
    st.memo ? 'メモ：' + st.memo : ''
  ].filter(Boolean), appUrl, buttonLabel);

  cache.put(dedupeKey, '1', 21600);
  return { ok:true, sent:1 };
}

function member_(user, appUrl) {
  if (user.role !== 'pending') return { ok:true, sent:0 };
  const cache = CacheService.getScriptCache();
  if (cache.get('member_' + user.uid)) return { ok:true, sent:0 };
  cache.put('member_' + user.uid, '1', 21600);
  const to = recipientsByRole_('treasurer');
  if (!to.length) throw new Error('会計担当の通知先が登録されていません');
  send_(to, '【会計簿】利用申請 ' + user.name, [
    '会計簿に新しい利用申請が届きました。',
    '', '氏名：' + user.name, 'メール：' + user.email, '',
    '会計担当が「設定」の利用者一覧で、会計・監査・役員・支払者の権限を設定してください。',
    '支払者名簿との紐付けは不要です。'
  ], appUrl, '会計簿を開く');
  return { ok:true, sent:1 };
}

/* ---------- Claude AI中継 ----------
 * ブラウザからは画像・読取指示・Firebase IDトークンだけを受け取る。
 * Claude APIキーはScript Propertiesの CLAUDE_API_KEY のみ。
 */
function claude_(user, req) {
  // pending/removed はAIを利用できない。その他の承認済みロールは利用可。
  if (!user || ['pending','removed'].includes(user.role)) {
    throw new Error('AIを利用する権限がありません');
  }

  const images = Array.isArray(req.images) ? req.images : [];
  if (images.length > CLAUDE_MAX_IMAGES) throw new Error('画像は一度に' + CLAUDE_MAX_IMAGES + '枚までです');

  const content = images.map(function(dataUrl) {
    dataUrl = String(dataUrl || '');
    if (dataUrl.length > CLAUDE_MAX_IMAGE_CHARS || !/^data:image\//.test(dataUrl)) {
      throw new Error('画像データを確認できません');
    }
    const comma = dataUrl.indexOf(',');
    if (comma < 0) throw new Error('画像データを確認できません');
    const mediaType = (dataUrl.slice(5, comma).split(';')[0] || 'image/jpeg');
    return {
      type:'image',
      source:{ type:'base64', media_type:mediaType, data:dataUrl.slice(comma + 1) }
    };
  });

  const prompt = String(req.prompt || '');
  const system = String(req.system || '');
  if (!prompt) throw new Error('AIへの読取指示がありません');
  content.push({ type:'text', text:prompt });

  const apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) throw new Error('CLAUDE_KEY_MISSING');

  const maxTokens = Math.max(100, Math.min(Number(req.maxTokens) || 1000, 5000));
  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method:'post',
    contentType:'application/json',
    headers:{
      'x-api-key':apiKey,
      'anthropic-version':'2023-06-01'
    },
    payload:JSON.stringify({
      model:CLAUDE_MODEL,
      max_tokens:maxTokens,
      system:system,
      messages:[{ role:'user', content:content }]
    }),
    muteHttpExceptions:true
  });

  const status = res.getResponseCode();
  if (status < 200 || status >= 300) {
    // Claudeのレスポンス本文やAPIキーはブラウザへ返さない。
    console.error('Claude API error ' + status + ': ' + res.getContentText().slice(0, 500));
    throw new Error('CLAUDE_' + status);
  }

  const data = JSON.parse(res.getContentText());
  const answer = (data.content || [])
    .filter(function(x){ return x.type === 'text'; })
    .map(function(x){ return x.text; })
    .join('')
    .replace(/```json|```/g, '')
    .trim();

  const a = answer.indexOf('{');
  const b = answer.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('CLAUDE_JSON');
  return JSON.parse(answer.slice(a, b + 1));
}

function claudeRateOk_(uid) {
  const cache = CacheService.getScriptCache();
  const key = 'claude_rate_' + uid;
  const n = Number(cache.get(key) || 0);
  if (n >= CLAUDE_MAX_PER_HOUR) return false;
  cache.put(key, String(n + 1), 3600);
  return true;
}

function writeGasResponse_(user,requestId,ok,result,error){
  if(!user||!user.uid||!user.token)throw new Error('応答書込用の認証情報がありません');
  if(!requestId||!/^[A-Za-z0-9_-]{8,160}$/.test(String(requestId)))throw new Error('requestIdが不正です');
  const body={
    requestId:String(requestId),
    ok:!!ok,
    at:Date.now()
  };
  if(ok)body.result=result;
  else body.error=String(error||'処理に失敗しました');

  const url=DB_URL+'/'+ROOT+'/gasResponses/'+encodeURIComponent(user.uid)+'/'+encodeURIComponent(String(requestId))+'.json?auth='+encodeURIComponent(user.token);
  const res=UrlFetchApp.fetch(url,{
    method:'put',
    contentType:'application/json',
    payload:JSON.stringify(body),
    muteHttpExceptions:true
  });
  const code=res.getResponseCode();
  if(code<200||code>=300)throw new Error('Firebaseへの応答書込みに失敗しました（'+code+'）');
  return true;
}

/* ---------- 共通 ---------- */
function send_(to, subject, lines, buttonUrl, buttonLabel) {
  to = uniqueEmails_(to);
  if (!to.length) throw new Error('メールの送信先がありません');
  const text = lines.join('\n') + (buttonUrl ? '\n\n' + buttonUrl : '') + '\n\n― 町内会 会計簿（自動送信）';
  const html = '<div style="font-family:sans-serif;font-size:14px;line-height:1.7;color:#3A322A">' +
    lines.map(function(l) { return esc_(l).replace(/(https:\/\/\S+)/g, '<a href="$1">$1</a>'); }).join('<br>') +
    (buttonUrl ? '<p style="margin-top:18px"><a href="' + esc_(buttonUrl) + '" style="background:#B4432C;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:bold">' + esc_(buttonLabel) + '</a></p>' : '') +
    '<p style="color:#8A7F6E;font-size:12px">町内会 会計簿（自動送信）</p></div>';
  MailApp.sendEmail({ to:to.join(','), subject:subject, body:text, htmlBody:html, name:'町内会 会計簿' });
}
function rateOk_(uid) {
  const cache = CacheService.getScriptCache();
  const key = 'rate_' + uid;
  const n = Number(cache.get(key) || 0);
  if (n >= MAX_PER_HOUR) return false;
  cache.put(key, String(n + 1), 3600);
  return true;
}
function yen_(n) { return '¥' + (Number(n) || 0).toLocaleString('ja-JP'); }
function esc_(s) { return String(s).replace(/[&<>\"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c])); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
