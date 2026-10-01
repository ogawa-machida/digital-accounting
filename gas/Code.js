/**
 * 町内会 デジタル会計 ― メール通知
 * 2026.10.01-25 対応版
 *
 * GitHub Pages → Google Apps Script のCORS問題を避けるため、
 * JSON POSTに加えてHTMLフォームPOST（payload）にも対応。
 *
 * 通知先：
 * ・役員／支払者からの通常申請 → 会計担当
 * ・班長からの現金会費申告     → 会計担当
 * ・会計担当本人の立替申請     → 役員
 * ・現金会費の差戻し           → 申告した班長本人
 * ・利用申請                   → 会計担当
 *
 * メール本文や宛先はブラウザから信用せず、
 * Firebase IDトークンで本人確認したうえで
 * Realtime Databaseから読み直して生成する。
 */

const DB_URL =
  'https://ogawa-machida-default-rtdb.asia-southeast1.firebasedatabase.app';

const ROOT = 'chokai-kaikei';

const APP_URL =
  'https://ogawa-machida.github.io/digital-accounting/';

const MAX_PER_HOUR = 40;


/* =========================================================
 * Webアプリ入口
 * ========================================================= */

function doPost(e) {
  try {

    /*
     * -25からはHTML formで
     *
     * payload = JSON.stringify(...)
     *
     * を送る。
     *
     * 旧版との互換性のため、
     * application/json のPOSTにも対応する。
     */
    let req = null;

    if (
      e &&
      e.parameter &&
      e.parameter.payload
    ) {

      req = JSON.parse(
        e.parameter.payload
      );

    } else if (
      e &&
      e.postData &&
      e.postData.contents
    ) {

      req = JSON.parse(
        e.postData.contents
      );

    } else {

      throw new Error(
        '送信内容がありません'
      );
    }


    const user =
      verifyUser_(req.idToken);

    const appUrl = APP_URL;


    if (!rateOk_(user.uid)) {

      return json_({
        ok: false,
        error:
          '送信回数が多すぎます。しばらく待ってください'
      });

    }


    switch (req.action) {

      case 'register':

        return json_(
          register_(user)
        );


      case 'test':

        return json_(
          test_(
            user,
            appUrl
          )
        );


      case 'entry':

        return json_(
          entry_(
            user,
            req.entryIds || [],
            appUrl
          )
        );


      case 'cashFeeReturn':

        return json_(
          cashFeeReturn_(
            user,
            req.entryId || '',
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
          error:
            '不明な操作です'
        });
    }

  } catch (err) {

    return json_({
      ok: false,
      error:
        String(
          err.message || err
        )
    });

  }
}


function doGet() {

  return json_({
    ok: true,
    message:
      '会計簿メール通知は動作しています'
  });

}


/* =========================================================
 * Firebase本人確認
 * ========================================================= */

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
          Utilities
            .base64DecodeWebSafe(seg)
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
   * JWTの中身を見るだけではなく、
   * 実際にIDトークン付きで
   * Realtime Databaseを読み、
   * Firebaseルールでも本人確認する。
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

    name:
      member.name || '',

    email:
      member.email || '',

    role:
      member.role || '',

    officerType:
      member.officerType || '',

    payerId:
      member.payerId || ''

  };

}


/* =========================================================
 * Firebase読み取り
 * ========================================================= */

function read_(path, token) {

  const url =
    DB_URL +
    '/' +
    ROOT +
    '/' +
    path +
    '.json?auth=' +
    encodeURIComponent(token);


  const res =
    UrlFetchApp.fetch(
      url,
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
 * 通知先登録
 * ========================================================= */

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
      .map(function (key) {

        return members[key] || {};

      });


  const treasurers =
    uniqueEmails_(

      values
        .filter(function (m) {

          return (
            m.role ===
            'treasurer'
          );

        })
        .map(function (m) {

          return m.email;

        })

    );


  const viewers =
    uniqueEmails_(

      values
        .filter(function (m) {

          return (
            m.role ===
            'viewer'
          );

        })
        .map(function (m) {

          return m.email;

        })

    );


  const props =
    PropertiesService
      .getScriptProperties();


  props.setProperty(
    'TREASURER_RECIPIENTS',
    JSON.stringify(
      treasurers
    )
  );


  props.setProperty(
    'VIEWER_RECIPIENTS',
    JSON.stringify(
      viewers
    )
  );


  /*
   * 旧版との互換用
   */
  props.setProperty(
    'RECIPIENTS',
    JSON.stringify(
      treasurers
    )
  );


  return {

    ok: true,

    recipients:
      treasurers,

    treasurerRecipients:
      treasurers,

    viewerRecipients:
      viewers

  };

}


/* =========================================================
 * 役割別通知先
 * ========================================================= */

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
   * 会計担当については
   * 旧RECIPIENTSも確認する。
   */
  if (role === 'treasurer') {

    const legacy =
      JSON.parse(
        props.getProperty(
          'RECIPIENTS'
        ) || '[]'
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
 * メールアドレス整理
 * ========================================================= */

function uniqueEmails_(list) {

  const seen = {};


  return (list || [])

    .map(function (x) {

      return String(
        x || ''
      )
        .trim()
        .toLowerCase();

    })

    .filter(function (x) {

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
 * テスト送信
 * ========================================================= */

function test_(user, appUrl) {

  if (
    user.role !==
    'treasurer'
  ) {

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

    recipients:
      to,

    treasurerRecipients:
      treasurers,

    viewerRecipients:
      viewers

  };

}


/* =========================================================
 * 伝票申請通知
 * ========================================================= */

function entry_(
  user,
  ids,
  appUrl
) {

  if (
    ![
      'payer',
      'guest',
      'viewer',
      'treasurer'
    ].includes(
      user.role
    )
  ) {

    throw new Error(
      '申請の通知を送る権限がありません'
    );

  }


  ids =
    (ids || [])
      .slice(0, 30);


  const normal = [];

  const treasurerOwn = [];

  const cashFees = [];


  ids.forEach(
    function (id) {

      const ent =
        read_(
          'entries/' + id,
          user.token
        );


      if (
        !ent ||
        ent.status !==
          'submitted'
      ) {

        return;

      }


      /*
       * 通知を起こした本人が
       * 作成した伝票だけを対象にする。
       */
      if (
        ent.createdBy &&
        ent.createdBy !==
          user.uid
      ) {

        return;

      }


      ent.id = id;


      /*
       * 現金会費は通常の支出申請とは
       * 別のメールにする。
       */
      if (
        ent.cashFeeRequest ===
        true
      ) {

        /*
         * 現金会費を申告できるのは
         * 班長のみ。
         */
        if (
          user.role !==
            'viewer' ||
          user.officerType !==
            'leader'
        ) {

          throw new Error(
            '現金会費を申告した班長を確認できません'
          );

        }


        cashFees.push(ent);

        return;

      }


      if (
        ent.selfApprovalRequired
      ) {

        /*
         * 自己承認回避フラグは
         * 会計担当本人の伝票のみ。
         */
        if (
          user.role !==
            'treasurer' ||
          ent.createdBy !==
            user.uid
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
         * 会計担当の通常伝票を
         * 会計自身へ送ることはしない。
         */
        if (
          user.role ===
          'treasurer'
        ) {

          throw new Error(
            '会計担当の立替申請には役員承認が必要です'
          );

        }


        normal.push(ent);

      }

    }
  );


  let sent = 0;


  /*
   * 班長 → 会計
   * 現金会費
   */
  if (cashFees.length) {

    const to =
      recipientsByRole_(
        'treasurer'
      );


    if (!to.length) {

      throw new Error(
        '会計担当の通知先が登録されていません'
      );

    }


    cashFees.forEach(
      function (ent) {

        sendCashFeeSubmission_(
          ent,
          user,
          to,
          appUrl
        );

        sent++;

      }
    );

  }


  /*
   * 通常申請 → 会計
   */
  if (normal.length) {

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
   * 会計担当本人 → 役員
   */
  if (treasurerOwn.length) {

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
 * 現金会費申告メール
 * ========================================================= */

function sendCashFeeSubmission_(
  ent,
  user,
  to,
  appUrl
) {

  const count =
    Number(
      ent.cashFeeCount
    ) || 0;


  const amount =
    Number(
      ent.cashFeeDeclaredAmount ||
      ent.amount
    ) || 0;


  const branch =
    ent.cashFeeBranch ||
    user.branch ||
    '';


  const group =
    ent.cashFeeGroup ||
    user.group ||
    '';


  const place =
    [
      branch,
      group
    ]
      .filter(Boolean)
      .join(' ');


  const memo =
    ent.cashFeeMemo ||
    ent.memo ||
    '';


  const isResubmit =
    !!(
      ent.returnReason ||
      ent.cashFeeActualAmount
    );


  const subject =
    isResubmit

      ? '【デジタル会計】現金会費が再申告されました ' +
        (place || '')

      : '【デジタル会計】現金会費の受取確認依頼 ' +
        (place || '');


  const lines = [

    (
      user.name ||
      '班長'
    ) +
    'さんから、現金会費の' +
    (
      isResubmit
        ? '再申告'
        : '受取確認依頼'
    ) +
    'が届きました。',

    '',

    '支部・班：' +
      (
        place ||
        '－'
      ),

    '申告者：' +
      (
        user.name ||
        '－'
      ),

    '現金で会費を納めた世帯数：' +
      count +
      '世帯',

    '班長申告額：' +
      yen_(amount),

    '備考・メモ：' +
      (
        memo ||
        'なし'
      ),

    '',

    '会計担当が実際の現金を数え、受取確認を行ってください。'

  ];


  send_(
    to,

    subject,

    lines,

    appUrl +
      '?open=' +
      encodeURIComponent(
        ent.id
      ),

    '現金会費を確認する'
  );

}


/* =========================================================
 * 通常伝票メール
 * ========================================================= */

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
      function (s, e) {

        return (
          s +
          (
            Number(
              e.amount
            ) || 0
          )
        );

      },
      0
    );


  const isTreasurerOwn =
    targetRole ===
    'viewer';


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
    function (ent) {

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
            ] || {}
          ).name ||
          '－'
        ) +
        '　／　支払方法：' +
        (
          (
            methods[
              ent.methodId
            ] || {}
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
    yen_(total)
  );


  const subject =
    isTreasurerOwn

      ? '【会計簿】会計担当から承認依頼 ' +
        who +
        ' ' +
        list.length +
        '件 ' +
        yen_(total)

      : '【会計簿】承認依頼 ' +
        who +
        ' ' +
        list.length +
        '件 ' +
        yen_(total);


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
 * 現金会費差戻し → 班長
 * ========================================================= */

function cashFeeReturn_(
  user,
  entryId,
  appUrl
) {

  if (
    user.role !==
    'treasurer'
  ) {

    throw new Error(
      '現金会費を差し戻せるのは会計担当のみです'
    );

  }


  if (!entryId) {

    throw new Error(
      '差戻し対象が指定されていません'
    );

  }


  const ent =
    read_(
      'entries/' +
        entryId,
      user.token
    );


  if (
    !ent ||
    ent.cashFeeRequest !==
      true ||
    ent.status !==
      'returned'
  ) {

    throw new Error(
      '差戻し済みの現金会費を確認できません'
    );

  }


  if (
    ent.cashFeeCheckedBy &&
    ent.cashFeeCheckedBy !==
      user.uid
  ) {

    throw new Error(
      '差戻しを行った会計担当を確認できません'
    );

  }


  if (!ent.createdBy) {

    throw new Error(
      '申告した班長を確認できません'
    );

  }


  const member =
    read_(
      'members/' +
        ent.createdBy,
      user.token
    ) || {};


  if (
    member.role !==
      'viewer' ||
    member.officerType !==
      'leader'
  ) {

    throw new Error(
      '申告した班長を確認できません'
    );

  }


  const to =
    uniqueEmails_([
      member.email
    ]);


  if (!to.length) {

    throw new Error(
      '班長のメールアドレスが登録されていません'
    );

  }


  const declared =
    Number(
      ent.cashFeeDeclaredAmount ||
      ent.amount
    ) || 0;


  const actual =
    Number(
      ent.cashFeeActualAmount
    ) || 0;


  const diff =
    actual -
    declared;


  const branch =
    ent.cashFeeBranch ||
    member.branch ||
    '';


  const group =
    ent.cashFeeGroup ||
    member.group ||
    '';


  const place =
    [
      branch,
      group
    ]
      .filter(Boolean)
      .join(' ');


  /*
   * 同じ差戻し操作による
   * 重複メールを防止する。
   */
  const cache =
    CacheService
      .getScriptCache();


  const dedupeKey =
    'cashFeeReturn_' +
    entryId +
    '_' +
    String(
      ent.cashFeeCheckedAt ||
      ent.updatedAt ||
      ''
    );


  if (
    cache.get(
      dedupeKey
    )
  ) {

    return {

      ok: true,

      sent: 0,

      duplicate: true

    };

  }


  send_(

    to,

    '【デジタル会計】現金会費の確認をお願いします ' +
      (
        place ||
        ''
      ),

    [

      (
        member.name ||
        '班長'
      ) +
      'さん',

      '',

      '会計担当が現金会費を確認した結果、申告内容が差し戻されました。',

      'デジタル会計を開き、内容を確認して修正・再申告してください。',

      '',

      '支部・班：' +
        (
          place ||
          '－'
        ),

      '現金納付世帯数：' +
        (
          Number(
            ent.cashFeeCount
          ) || 0
        ) +
        '世帯',

      '班長申告額：' +
        yen_(
          declared
        ),

      '会計確認額：' +
        yen_(
          actual
        ),

      '差額：' +
        (
          diff > 0
            ? '+'
            : ''
        ) +
        yen_(
          diff
        ),

      '差戻し理由：' +
        (
          ent.returnReason ||
          '内容を確認してください'
        ),

      '',

      '会計確認者：' +
        (
          ent.cashFeeCheckedByName ||
          user.name ||
          '会計担当'
        )

    ],

    appUrl +
      '?open=' +
      encodeURIComponent(
        entryId
      ),

    '差戻し内容を確認する'

  );


  /*
   * 6時間重複防止
   */
  cache.put(
    dedupeKey,
    '1',
    21600
  );


  return {

    ok: true,

    sent: 1

  };

}


/* =========================================================
 * 利用申請
 * ========================================================= */

function member_(
  user,
  appUrl
) {

  if (
    user.role !==
    'pending'
  ) {

    return {

      ok: true,

      sent: 0

    };

  }


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
 * メール送信共通
 * ========================================================= */

function send_(
  to,
  subject,
  lines,
  buttonUrl,
  buttonLabel
) {

  to =
    uniqueEmails_(to);


  if (!to.length) {

    throw new Error(
      'メールの送信先がありません'
    );

  }


  const text =
    lines.join('\n') +

    (
      buttonUrl
        ? '\n\n' +
          buttonUrl
        : ''
    ) +

    '\n\n― 小川自治会 デジタル会計（自動送信）';


  const html =

    '<div style="' +
      'font-family:sans-serif;' +
      'font-size:14px;' +
      'line-height:1.7;' +
      'color:#3A322A' +
    '">' +

    lines
      .map(
        function (line) {

          return esc_(line)
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
          esc_(buttonUrl) +
          '" style="' +
            'background:#B4432C;' +
            'color:#fff;' +
            'padding:10px 18px;' +
            'border-radius:6px;' +
            'text-decoration:none;' +
            'font-weight:bold' +
          '">' +

          esc_(
            buttonLabel ||
            'デジタル会計を開く'
          ) +

          '</a>' +

          '</p>'

        : ''
    ) +

    '<p style="' +
      'color:#8A7F6E;' +
      'font-size:12px' +
    '">' +

      '小川自治会 デジタル会計（自動送信）' +

    '</p>' +

    '</div>';


  MailApp.sendEmail({

    to:
      to.join(','),

    subject:
      subject,

    body:
      text,

    htmlBody:
      html,

    name:
      '小川自治会 デジタル会計'

  });

}


/* =========================================================
 * 送信回数制限
 * ========================================================= */

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
    n >=
    MAX_PER_HOUR
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
 * 金額表示
 * ========================================================= */

function yen_(n) {

  return (
    '¥' +
    (
      Number(n) ||
      0
    )
      .toLocaleString(
        'ja-JP'
      )
  );

}


/* =========================================================
 * HTMLエスケープ
 * ========================================================= */

function esc_(s) {

  return String(
    s == null
      ? ''
      : s
  )
    .replace(
      /[&<>\"]/g,
      function (c) {

        return {

          '&':
            '&amp;',

          '<':
            '&lt;',

          '>':
            '&gt;',

          '"':
            '&quot;'

        }[c];

      }
    );

}


/* =========================================================
 * JSONレスポンス
 * ========================================================= */

function json_(o) {

  return ContentService
    .createTextOutput(
      JSON.stringify(o)
    )
    .setMimeType(
      ContentService
        .MimeType
        .JSON
    );

}
