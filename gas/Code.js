/**
 * デジタル会計 ― メール通知
 * GitHub / clasp 管理版
 */

const DB_URL =
  'https://ogawa-machida-default-rtdb.asia-southeast1.firebasedatabase.app';

const ROOT = 'chokai-kaikei';

const APP_URL =
  'https://ogawa-machida.github.io/digital-accounting/';

const MAX_PER_HOUR = 40;

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    const user = verifyUser_(req.idToken);

    if (!rateOk_(user.uid)) {
      return json_({
        ok: false,
        error: '送信回数が多すぎます。しばらく待ってください'
      });
    }

    switch (req.action) {
      case 'register':
        return json_(register_(user));
      case 'test':
        return json_(test_(user, APP_URL));
      case 'entry':
        return json_(entry_(user, req.entryIds || [], APP_URL));
      case 'member':
        return json_(member_(user, APP_URL));
      default:
        return json_({
          ok: false,
          error: '不明な操作です'
        });
    }
  } catch (err) {
    return json_({
      ok: false,
      error: String(err.message || err)
    });
  }
}

function doGet() {
  return json_({
    ok: true,
    message: 'デジタル会計メール通知は動作しています'
  });
}

function verifyUser_(idToken) {
  if (!idToken) {
    throw new Error('ログイン情報がありません');
  }

  let seg = String(idToken).split('.')[1] || '';

  seg += '===='.slice(
    0,
    (4 - seg.length % 4) % 4
  );

  const payload = JSON.parse(
    Utilities.newBlob(
      Utilities.base64DecodeWebSafe(seg)
    ).getDataAsString()
  );

  const uid = payload.user_id || payload.sub;

  if (!uid) {
    throw new Error('ログイン情報が不正です');
  }

  const member = read_(
    'members/' + uid,
    idToken
  );

  if (!member) {
    throw new Error(
      'デジタル会計の利用者として登録されていません'
    );
  }

  return {
    uid: uid,
    token: idToken,
    name: member.name || '',
    email: member.email || '',
    role: member.role || '',
    payerId: member.payerId || ''
  };
}

function read_(path, token) {
  const url =
    DB_URL +
    '/' +
    ROOT +
    '/' +
    path +
    '.json?auth=' +
    encodeURIComponent(token);

  const res = UrlFetchApp.fetch(
    url,
    { muteHttpExceptions: true }
  );

  const code = res.getResponseCode();

  if (code === 401 || code === 403) {
    throw new Error(
      'データベースの読み取りが許可されませんでした'
    );
  }

  if (code !== 200) {
    throw new Error(
      'データベースに接続できません（' +
      code +
      '）'
    );
  }

  return JSON.parse(res.getContentText());
}

function register_(user) {
  if (user.role !== 'treasurer') {
    throw new Error(
      '通知先の登録は会計担当のみできます'
    );
  }

  const members =
    read_('members', user.token) || {};

  const values = Object.keys(members).map(
    function (key) {
      return members[key] || {};
    }
  );

  const treasurers = uniqueEmails_(
    values
      .filter(function (member) {
        return member.role === 'treasurer';
      })
      .map(function (member) {
        return member.email;
      })
  );

  const viewers = uniqueEmails_(
    values
      .filter(function (member) {
        return member.role === 'viewer';
      })
      .map(function (member) {
        return member.email;
      })
  );

  const props =
    PropertiesService.getScriptProperties();

  props.setProperty(
    'TREASURER_RECIPIENTS',
    JSON.stringify(treasurers)
  );

  props.setProperty(
    'VIEWER_RECIPIENTS',
    JSON.stringify(viewers)
  );

  props.setProperty(
    'RECIPIENTS',
    JSON.stringify(treasurers)
  );

  return {
    ok: true,
    recipients: treasurers,
    treasurerRecipients: treasurers,
    viewerRecipients: viewers
  };
}

function recipientsByRole_(role) {
  const props =
    PropertiesService.getScriptProperties();

  const key =
    role === 'viewer'
      ? 'VIEWER_RECIPIENTS'
      : 'TREASURER_RECIPIENTS';

  const saved = JSON.parse(
    props.getProperty(key) || '[]'
  );

  if (saved.length) {
    return saved;
  }

  if (role === 'treasurer') {
    const legacy = JSON.parse(
      props.getProperty('RECIPIENTS') || '[]'
    );

    if (legacy.length) {
      return legacy;
    }

    const own =
      Session.getEffectiveUser().getEmail();

    return own ? [own] : [];
  }

  return [];
}

function uniqueEmails_(list) {
  const seen = {};

  return (list || [])
    .map(function (value) {
      return String(value || '')
        .trim()
        .toLowerCase();
    })
    .filter(function (value) {
      if (!value || seen[value]) {
        return false;
      }

      seen[value] = true;
      return true;
    });
}

function test_(user, appUrl) {
  if (user.role !== 'treasurer') {
    throw new Error(
      'テスト送信は会計担当のみできます'
    );
  }

  const treasurers =
    recipientsByRole_('treasurer');

  const viewers =
    recipientsByRole_('viewer');

  const to = uniqueEmails_(
    treasurers.concat(viewers)
  );

  if (!to.length) {
    throw new Error(
      '通知先が登録されていません。先に通知先を更新してください'
    );
  }

  send_(
    to,
    '【デジタル会計】テスト送信',
    [
      'メール通知の設定ができました。',
      '',
      '通常の承認依頼は会計担当へ、',
      '会計担当本人の立替申請は役員へ通知します。',
      '',
      '会計担当：' +
        (treasurers.length
          ? treasurers.join('、')
          : '未登録'),
      '',
      '役員：' +
        (viewers.length
          ? viewers.join('、')
          : '未登録'),
      '',
      '送信操作：' +
        user.name +
        '（' +
        user.email +
        '）'
    ],
    appUrl,
    'デジタル会計を開く'
  );

  return {
    ok: true,
    recipients: to,
    treasurerRecipients: treasurers,
    viewerRecipients: viewers
  };
}

function entry_(user, ids, appUrl) {
  if (
    ![
      'payer',
      'guest',
      'viewer',
      'treasurer'
    ].includes(user.role)
  ) {
    throw new Error(
      '申請の通知を送る権限がありません'
    );
  }

  ids = ids.slice(0, 30);

  const normal = [];
  const treasurerOwn = [];

  ids.forEach(function (id) {
    const entry = read_(
      'entries/' + id,
      user.token
    );

    if (
      !entry ||
      entry.status !== 'submitted'
    ) {
      return;
    }

    if (
      entry.createdBy &&
      entry.createdBy !== user.uid
    ) {
      return;
    }

    entry.id = id;

    if (entry.selfApprovalRequired) {
      if (
        user.role !== 'treasurer' ||
        entry.createdBy !== user.uid
      ) {
        throw new Error(
          '承認先を確認できない伝票があります'
        );
      }

      treasurerOwn.push(entry);
      return;
    }

    if (user.role === 'treasurer') {
      throw new Error(
        '会計担当の立替申請には役員承認が必要です'
      );
    }

    normal.push(entry);
  });

  let sent = 0;

  if (normal.length) {
    const to =
      recipientsByRole_('treasurer');

    if (!to.length) {
      throw new Error(
        '会計担当の通知先が登録されていません'
      );
    }

    sendEntryGroup_(
      normal,
      user,
      to,
      'treasurer',
      appUrl
    );

    sent += normal.length;
  }

  if (treasurerOwn.length) {
    const to =
      recipientsByRole_('viewer');

    if (!to.length) {
      throw new Error(
        '役員の通知先が登録されていません。デジタル会計の設定で役員を登録し、通知先を更新してください'
      );
    }

    sendEntryGroup_(
      treasurerOwn,
      user,
      to,
      'viewer',
      appUrl
    );

    sent += treasurerOwn.length;
  }

  return {
    ok: true,
    sent: sent
  };
}

function sendEntryGroup_(
  list,
  user,
  to,
  targetRole,
  appUrl
) {
  const accounts =
    read_('accounts', user.token) || {};

  const methods =
    read_('methods', user.token) || {};

  let payer = {};

  if (list[0].payerId) {
    try {
      payer =
        read_(
          'payers/' + list[0].payerId,
          user.token
        ) || {};
    } catch (err) {
      payer = {};
    }
  }

  const who =
    (
      payer.name ||
      user.name ||
      user.email ||
      '利用者'
    ) +
    (
      payer.post
        ? '（' + payer.post + '）'
        : ''
    );

  const total = list.reduce(
    function (sum, entry) {
      return (
        sum +
        (Number(entry.amount) || 0)
      );
    },
    0
  );

  const isTreasurerOwn =
    targetRole === 'viewer';

  const lines = [
    isTreasurerOwn
      ? '会計担当の' +
        who +
        'さんから、本人立替分の承認依頼が' +
        list.length +
        '件届きました。'
      : who +
        'さんから支出の承認依頼が' +
        list.length +
        '件届きました。',

    isTreasurerOwn
      ? '自己承認を避けるため、役員の方が内容を確認して承認してください。'
      : '会計担当の方が内容を確認してください。',

    ''
  ];

  list.forEach(function (entry) {
    lines.push(
      '■ ' +
      (entry.voucherNo || '伝票') +
      '　' +
      (entry.date || '') +
      '　' +
      yen_(entry.amount)
    );

    lines.push(
      '　用途：' +
      (entry.purpose || '－') +
      '　／　支払先：' +
      (entry.payee || '－')
    );

    lines.push(
      '　科目：' +
      (
        (accounts[entry.accountId] || {})
          .name || '－'
      ) +
      '　／　支払方法：' +
      (
        (methods[entry.methodId] || {})
          .name || '－'
      )
    );

    lines.push(
      '　写真：' +
      (
        entry.photoCount
          ? entry.photoCount + '枚'
          : entry.noReceipt
            ? '領収証なし（' +
              (entry.noReceiptReason || '') +
              '）'
            : 'なし'
      )
    );

    lines.push(
      '　確認：' +
      appUrl +
      '?open=' +
      encodeURIComponent(entry.id)
    );

    lines.push('');
  });

  lines.push(
    '合計　' + yen_(total)
  );

  const subject = isTreasurerOwn
    ? '【デジタル会計】会計担当から承認依頼 ' +
      who +
      ' ' +
      list.length +
      '件 ' +
      yen_(total)
    : '【デジタル会計】承認依頼 ' +
      who +
      ' ' +
      list.length +
      '件 ' +
      yen_(total);

  const firstUrl =
    appUrl +
    '?open=' +
    encodeURIComponent(list[0].id);

  send_(
    to,
    subject,
    lines,
    firstUrl,
    'この伝票を確認・承認する'
  );
}

function member_(user, appUrl) {
  if (user.role !== 'pending') {
    return {
      ok: true,
      sent: 0
    };
  }

  const cache =
    CacheService.getScriptCache();

  const cacheKey =
    'member_' + user.uid;

  if (cache.get(cacheKey)) {
    return {
      ok: true,
      sent: 0
    };
  }

  cache.put(
    cacheKey,
    '1',
    21600
  );

  const to =
    recipientsByRole_('treasurer');

  if (!to.length) {
    throw new Error(
      '会計担当の通知先が登録されていません'
    );
  }

  send_(
    to,
    '【デジタル会計】利用申請 ' +
      user.name,
    [
      'デジタル会計に新しい利用申請が届きました。',
      '',
      '氏名：' + user.name,
      'メール：' + user.email,
      '',
      '会計担当が「設定」の利用者一覧で、',
      '会計・監査・役員・支払者の権限を設定してください。',
      '',
      '支払者名簿との紐付けは不要です。'
    ],
    appUrl,
    'デジタル会計を開く'
  );

  return {
    ok: true,
    sent: 1
  };
}

function send_(
  to,
  subject,
  lines,
  buttonUrl,
  buttonLabel
) {
  to = uniqueEmails_(to);

  if (!to.length) {
    throw new Error(
      'メールの送信先がありません'
    );
  }

  const text =
    lines.join('\n') +
    (buttonUrl
      ? '\n\n' + buttonUrl
      : '') +
    '\n\n― デジタル会計（自動送信）';

  const html =
    '<div style="font-family:sans-serif;font-size:14px;line-height:1.7;color:#3A322A">' +
    lines
      .map(function (line) {
        return esc_(line).replace(
          /(https:\/\/\S+)/g,
          '<a href="$1">$1</a>'
        );
      })
      .join('<br>') +
    (
      buttonUrl
        ? '<p style="margin-top:18px"><a href="' +
          esc_(buttonUrl) +
          '" style="background:#B4432C;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:bold">' +
          esc_(buttonLabel) +
          '</a></p>'
        : ''
    ) +
    '<p style="color:#8A7F6E;font-size:12px">デジタル会計（自動送信）</p></div>';

  MailApp.sendEmail({
    to: to.join(','),
    subject: subject,
    body: text,
    htmlBody: html,
    name: 'デジタル会計'
  });
}

function rateOk_(uid) {
  const cache =
    CacheService.getScriptCache();

  const key =
    'rate_' + uid;

  const count =
    Number(cache.get(key) || 0);

  if (count >= MAX_PER_HOUR) {
    return false;
  }

  cache.put(
    key,
    String(count + 1),
    3600
  );

  return true;
}

function yen_(number) {
  return (
    '¥' +
    (Number(number) || 0)
      .toLocaleString('ja-JP')
  );
}

function esc_(value) {
  return String(value).replace(
    /[&<>"]/g,
    function (c) {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;'
      }[c];
    }
  );
}

function json_(object) {
  return ContentService
    .createTextOutput(
      JSON.stringify(object)
    )
    .setMimeType(
      ContentService.MimeType.JSON
    );
  }
