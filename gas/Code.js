/**
 * 町内会 会計簿 ― メール通知
 *
 * 通知先：
 * ・支払者／役員／仮登録者からの通常申請 → 会計担当
 * ・会計担当本人の立替申請             → 役員
 *
 * Firebase IDトークンで本人確認し、
 * Realtime Databaseから伝票・利用者情報を読み直して
 * メール本文を生成する。
 */

const DB_URL =
  'https://ogawa-machida-default-rtdb.asia-southeast1.firebasedatabase.app';

const ROOT = 'chokai-kaikei';

const APP_URL =
  'https://ogawa-machida.github.io/digital-accounting/';

const MAX_PER_HOUR = 40;


/* =========================================================
   Webアプリ入口
   ========================================================= */

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);

    const user = verifyUser_(req.idToken);

    const appUrl = APP_URL;

    if (!rateOk_(user.uid)) {
      return json_({
        ok: false,
        error: '送信回数が多すぎます。しばらく待ってください'
      });
    }

    switch (req.action) {

      case 'register':
        return json_(
          register_(user)
        );

      case 'test':
        return json_(
          test_(user, appUrl)
        );

      case 'entry':
        return json_(
          entry_(
            user,
            req.entryIds || [],
            appUrl
          )
        );

      case 'member':
        return json_(
          member_(
            user,
            appUrl
          )
        );

      default:
        return json_({
          ok: false,
          error: '不明な操作です'
        });
    }

  } catch (err) {

    return json_({
      ok: false,
      error: String(
        err.message || err
      )
    });
  }
}


function doGet() {

  return json_({
    ok: true,
    message: '会計簿メール通知は動作しています'
  });
}


/* =========================================================
   本人確認
   ========================================================= */

function verifyUser_(idToken) {

  if (!idToken) {
    throw new Error(
      'ログイン情報がありません'
    );
  }

  let seg =
    String(idToken)
      .split('.')[1] || '';

  seg +=
    '===='.slice(
      0,
      (4 - seg.length % 4) % 4
    );

  const payload =
    JSON.parse(
      Utilities
        .newBlob(
          Utilities.base64DecodeWebSafe(seg)
        )
        .getDataAsString()
    );

  const uid =
    payload.user_id ||
    payload.sub;

  if (!uid) {
    throw new Error(
      'ログイン情報が不正です'
    );
  }

  /*
   * IDトークン付きでFirebaseへアクセス。
   * Firebaseルール側でも本人確認される。
   */
  const member =
    read_(
      'members/' + uid,
      idToken
    );

  if (!member) {
    throw new Error(
      '会計簿の利用者として登録されていません'
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


/* =========================================================
   Firebase読み込み
   ========================================================= */

function read_(path, token) {

  const res =
    UrlFetchApp.fetch(
      DB_URL +
      '/' +
      ROOT +
      '/' +
      path +
      '.json?auth=' +
      encodeURIComponent(token),
      {
        muteHttpExceptions: true
      }
    );

  const code =
    res.getResponseCode();

  if (
    code === 401 ||
    code === 403
  ) {
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

  return JSON.parse(
    res.getContentText()
  );
}


/* =========================================================
   通知先登録
   ========================================================= */

/*
 * Script Properties に
 *
 * TREASURER_RECIPIENTS
 * VIEWER_RECIPIENTS
 *
 * を別々に保存する。
 */

function register_(user) {

  if (user.role !== 'treasurer') {
    throw new Error(
      '送信先の登録は会計担当のみできます'
    );
  }

  const members =
    read_(
      'members',
      user.token
    ) || {};

  const values =
    Object.keys(members)
      .map(function(k) {
        return members[k] || {};
      });

  /*
   * 会計担当
   */
  const treasurers =
    uniqueEmails_(
      values
        .filter(function(m) {
          return m.role === 'treasurer';
        })
        .map(function(m) {
          return m.email;
        })
    );

  /*
   * 役員
   */
  const viewers =
    uniqueEmails_(
      values
        .filter(function(m) {
          return m.role === 'viewer';
        })
        .map(function(m) {
          return m.email;
        })
    );

  const props =
    PropertiesService
      .getScriptProperties();

  props.setProperty(
    'TREASURER_RECIPIENTS',
    JSON.stringify(treasurers)
  );

  props.setProperty(
    'VIEWER_RECIPIENTS',
    JSON.stringify(viewers)
  );

  /*
   * 旧バージョンとの互換用
   */
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


/* =========================================================
   通知先取得
   ========================================================= */

function recipientsByRole_(role) {

  const props =
    PropertiesService
      .getScriptProperties();

  const key =
    role === 'viewer'
      ? 'VIEWER_RECIPIENTS'
      : 'TREASURER_RECIPIENTS';

  const saved =
    JSON.parse(
      props.getProperty(key) ||
      '[]'
    );

  if (saved.length) {
    return saved;
  }

  /*
   * 会計担当だけは
   * 旧バージョン設定との互換性を残す
   */
  if (role === 'treasurer') {

    const legacy =
      JSON.parse(
        props.getProperty(
          'RECIPIENTS'
        ) ||
        '[]'
      );

    if (legacy.length) {
      return legacy;
    }

    const own =
      Session
        .getEffectiveUser()
        .getEmail();

    return own
      ? [own]
      : [];
  }

  return [];
}


/* =========================================================
   メールアドレス整理
   ========================================================= */

function uniqueEmails_(list) {

  const seen = {};

  return (list || [])
    .map(function(x) {

      return String(
        x || ''
      )
        .trim()
        .toLowerCase();

    })
    .filter(function(x) {

      if (!x) {
        return false;
      }

      if (seen[x]) {
        return false;
      }

      seen[x] = true;

      return true;
    });
}


/* =========================================================
   テスト送信
   ========================================================= */

function test_(user, appUrl) {

  if (user.role !== 'treasurer') {
    throw new Error(
      'テスト送信は会計担当のみできます'
    );
  }

  const treasurers =
    recipientsByRole_(
      'treasurer'
    );

  const viewers =
    recipientsByRole_(
      'viewer'
    );

  const to =
    uniqueEmails_(
      treasurers.concat(
        viewers
      )
    );

  if (!to.length) {
    throw new Error(
      '通知先が登録されていません。先に「送信先を更新」してください'
    );
  }

  send_(
    to,

    '【会計簿】テスト送信',

    [
      'メール通知の設定ができました。',

      '通常の承認依頼は会計担当へ、会計担当本人の立替申請は役員へ通知します。',

      '',

      '会計担当：' +
      (
        treasurers.length
          ? treasurers.join('、')
          : '未登録'
      ),

      '役員：' +
      (
        viewers.length
          ? viewers.join('、')
          : '未登録'
      ),

      '',

      '送信操作：' +
      user.name +
      '（' +
      user.email +
      '）'
    ],

    appUrl,

    '会計簿を開く'
  );

  return {
    ok: true,
    recipients: to,
    treasurerRecipients: treasurers,
    viewerRecipients: viewers
  };
}


/* =========================================================
   支払い申請通知
   ========================================================= */

function entry_(user, ids, appUrl) {

  /*
   * 支払者
   * 仮登録
   * 役員
   * 会計
   *
   * からの申請通知を許可
   */
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

  /*
   * 一度に最大30件
   */
  ids =
    ids.slice(
      0,
      30
    );

  /*
   * 通常申請
   *
   * 支払者
   * 仮登録
   * 役員
   *
   * → 会計担当
   */
  const normal = [];

  /*
   * 会計本人の立替申請
   *
   * → 役員
   */
  const treasurerOwn = [];


  ids.forEach(function(id) {

    /*
     * HTMLから渡された伝票内容は信用せず、
     * Firebaseから読み直す。
     */
    const ent =
      read_(
        'entries/' + id,
        user.token
      );

    if (
      !ent ||
      ent.status !== 'submitted'
    ) {
      return;
    }

    /*
     * 通知操作をした本人が
     * 作成した伝票だけを対象にする。
     */
    if (
      ent.createdBy &&
      ent.createdBy !== user.uid
    ) {
      return;
    }

    ent.id = id;


    /*
     * 会計本人の申請
     */
    if (
      ent.selfApprovalRequired
    ) {

      /*
       * selfApprovalRequired は
       * 会計本人の伝票にしか認めない。
       */
      if (
        user.role !== 'treasurer' ||
        ent.createdBy !== user.uid
      ) {
        throw new Error(
          '承認先を確認できない伝票があります'
        );
      }

      treasurerOwn.push(
        ent
      );

    } else {

      /*
       * 会計担当が
       * 自分自身へ通常承認依頼を
       * 送ることは禁止。
       */
      if (
        user.role === 'treasurer'
      ) {
        throw new Error(
          '会計担当の立替申請には役員承認が必要です'
        );
      }

      normal.push(
        ent
      );
    }
  });


  let sent = 0;


  /*
   * 通常申請
   *
   * → 会計担当
   */
  if (
    normal.length
  ) {

    const to =
      recipientsByRole_(
        'treasurer'
      );

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

    sent +=
      normal.length;
  }


  /*
   * 会計本人の申請
   *
   * → 役員
   */
  if (
    treasurerOwn.length
  ) {

    const to =
      recipientsByRole_(
        'viewer'
      );

    if (!to.length) {
      throw new Error(
        '役員の通知先が登録されていません。会計簿の設定で役員を登録し、通知先を更新してください'
      );
    }

    sendEntryGroup_(
      treasurerOwn,
      user,
      to,
      'viewer',
      appUrl
    );

    sent +=
      treasurerOwn.length;
  }


  return {
    ok: true,
    sent: sent
  };
}


/* =========================================================
   申請メール本文
   ========================================================= */

function sendEntryGroup_(
  list,
  user,
  to,
  targetRole,
  appUrl
) {

  const acc =
    read_(
      'accounts',
      user.token
    ) || {};

  const methods =
    read_(
      'methods',
      user.token
    ) || {};

  /*
   * 支払者情報
   */
  const p =
    (
      list[0].payerId

        ? read_(
            'payers/' +
            list[0].payerId,
            user.token
          )

        : null
    ) || {};


  const who =
    (
      p.name ||
      user.name ||
      user.email ||
      '利用者'
    ) +
    (
      p.post
        ? '（' +
          p.post +
          '）'
        : ''
    );


  const total =
    list.reduce(
      function(s, e) {

        return (
          s +
          (
            Number(
              e.amount
            ) ||
            0
          )
        );
      },
      0
    );


  /*
   * 役員宛てなら
   * 会計本人の申請
   */
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


  list.forEach(
    function(ent) {

      lines.push(
        '■ ' +
        (
          ent.voucherNo ||
          '伝票'
        ) +
        '　' +
        (
          ent.date ||
          ''
        ) +
        '　' +
        yen_(
          ent.amount
        )
      );


      lines.push(
        '　用途：' +
        (
          ent.purpose ||
          '－'
        ) +
        '　／　支払先：' +
        (
          ent.payee ||
          '－'
        )
      );


      lines.push(
        '　科目：' +
        (
          (
            acc[
              ent.accountId
            ] ||
            {}
          ).name ||
          '－'
        ) +
        '　／　支払方法：' +
        (
          (
            methods[
              ent.methodId
            ] ||
            {}
          ).name ||
          '－'
        )
      );


      lines.push(
        '　写真：' +
        (
          ent.photoCount

            ? ent.photoCount +
              '枚'

            : (
                ent.noReceipt

                  ? '領収証なし（' +
                    (
                      ent.noReceiptReason ||
                      ''
                    ) +
                    '）'

                  : 'なし'
              )
        )
      );


      lines.push(
        '　確認：' +
        appUrl +
        '?open=' +
        encodeURIComponent(
          ent.id
        )
      );


      lines.push('');
    }
  );


  lines.push(
    '合計　' +
    yen_(
      total
    )
  );


  const subject =
    isTreasurerOwn

      ? '【会計簿】会計担当から承認依頼 ' +
        who +
        ' ' +
        list.length +
        '件 ' +
        yen_(
          total
        )

      : '【会計簿】承認依頼 ' +
        who +
        ' ' +
        list.length +
        '件 ' +
        yen_(
          total
        );


  const firstUrl =
    appUrl +
    '?open=' +
    encodeURIComponent(
      list[0].id
    );


  send_(
    to,
    subject,
    lines,
    firstUrl,
    'この伝票を確認・承認する'
  );
}


/* =========================================================
   新規利用申請
   ========================================================= */

function member_(
  user,
  appUrl
) {

  /*
   * pending以外なら通知不要
   */
  if (
    user.role !== 'pending'
  ) {
    return {
      ok: true,
      sent: 0
    };
  }


  /*
   * 同じ人の利用申請メールを
   * 6時間以内に重複送信しない
   */
  const cache =
    CacheService
      .getScriptCache();


  if (
    cache.get(
      'member_' +
      user.uid
    )
  ) {
    return {
      ok: true,
      sent: 0
    };
  }


  cache.put(
    'member_' +
    user.uid,
    '1',
    21600
  );


  const to =
    recipientsByRole_(
      'treasurer'
    );


  if (!to.length) {
    throw new Error(
      '会計担当の通知先が登録されていません'
    );
  }


  send_(
    to,

    '【会計簿】利用申請 ' +
    user.name,

    [
      '会計簿に新しい利用申請が届きました。',

      '',

      '氏名：' +
      user.name,

      'メール：' +
      user.email,

      '',

      '会計担当が「設定」の利用者一覧で、会計・監査・役員・支払者の権限を設定してください。',

      '支払者名簿との紐付けは不要です。'
    ],

    appUrl,

    '会計簿を開く'
  );


  return {
    ok: true,
    sent: 1
  };
}


/* =========================================================
   メール送信
   ========================================================= */

function send_(
  to,
  subject,
  lines,
  buttonUrl,
  buttonLabel
) {

  to =
    uniqueEmails_(
      to
    );


  if (!to.length) {
    throw new Error(
      'メールの送信先がありません'
    );
  }


  /*
   * テキストメール
   */
  const text =
    lines.join('\n') +

    (
      buttonUrl

        ? '\n\n' +
          buttonUrl

        : ''
    ) +

    '\n\n― 町内会 会計簿（自動送信）';


  /*
   * HTMLメール
   */
  const html =
    '<div style="' +
    'font-family:sans-serif;' +
    'font-size:14px;' +
    'line-height:1.7;' +
    'color:#3A322A' +
    '">' +

    lines
      .map(
        function(l) {

          return esc_(l)
            .replace(
              /(https:\/\/\S+)/g,
              '<a href="$1">$1</a>'
            );
        }
      )
      .join('<br>') +

    (
      buttonUrl

        ? '<p style="margin-top:18px">' +

          '<a href="' +
          esc_(
            buttonUrl
          ) +
          '" style="' +

          'background:#B4432C;' +
          'color:#fff;' +
          'padding:10px 18px;' +
          'border-radius:6px;' +
          'text-decoration:none;' +
          'font-weight:bold' +

          '">' +

          esc_(
            buttonLabel
          ) +

          '</a>' +
          '</p>'

        : ''
    ) +

    '<p style="' +
    'color:#8A7F6E;' +
    'font-size:12px' +
    '">' +

    '町内会 会計簿（自動送信）' +

    '</p>' +

    '</div>';


  MailApp.sendEmail({
    to: to.join(','),
    subject: subject,
    body: text,
    htmlBody: html,
    name: '町内会 会計簿'
  });
}


/* =========================================================
   送信回数制限
   ========================================================= */

function rateOk_(uid) {

  const cache =
    CacheService
      .getScriptCache();

  const key =
    'rate_' +
    uid;

  const n =
    Number(
      cache.get(key) ||
      0
    );


  if (
    n >= MAX_PER_HOUR
  ) {
    return false;
  }


  cache.put(
    key,
    String(
      n + 1
    ),
    3600
  );


  return true;
}


/* =========================================================
   共通関数
   ========================================================= */

function yen_(n) {

  return (
    '¥' +
    (
      Number(n) ||
      0
    ).toLocaleString(
      'ja-JP'
    )
  );
}


function esc_(s) {

  return String(s)
    .replace(
      /[&<>\"]/g,
      function(c) {

        return {
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '\"': '&quot;'
        }[c];
      }
    );
}


function json_(o) {

  return ContentService
    .createTextOutput(
      JSON.stringify(o)
    )
    .setMimeType(
      ContentService.MimeType.JSON
    );
    }
