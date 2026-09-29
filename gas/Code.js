/**
 * デジタル会計 ― メール通知
 * GitHub / clasp 管理版
 *
 * 通知先
 * ・支払者／役員からの支出申請 → 会計担当
 * ・会計担当本人の立替申請     → 役員
 * ・新規利用申請               → 会計担当
 */

const DB_URL =
  'https://ogawa-machida-default-rtdb.asia-southeast1.firebasedatabase.app';

const ROOT = 'chokai-kaikei';

const APP_URL =
  'https://ogawa-machida.github.io/digital-accounting/';

const MAX_PER_HOUR = 40;


/* =========================================================
   Web App
   ========================================================= */

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
        return json_(
          entry_(
            user,
            req.entryIds || [],
            APP_URL
          )
        );

      case 'member':
        return json_(
          member_(user, APP_URL)
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
    String(idToken).split('.')[1] || '';

  seg +=
    '===='.slice(
      0,
      (4 - seg.length % 4) %
