// au サービス案内チャットボット ナレッジベース
//
// 運用ルール:
// - ここに載っている情報「だけ」がチャットボットの回答になります(憶測回答の防止)
// - 追加・修正は PR 経由で行い、スタッフが出典 URL を実際に確認してから
//   verified を true にし、lastVerified を更新すること
// - verified が false の項目は、回答時に「スタッフ未確認」バッジ付きで表示されます
// - 誤りが見つかった項目は、管理パネルで回答停止 → この
//   ファイルを修正する PR を出す、の順で直します

const AU_KNOWLEDGE = [
  {
    id: "contact-phone",
    title: "au への電話問い合わせ(総合案内)",
    keywords: ["問い合わせ", "問合せ", "電話", "電話番号", "157", "総合案内", "コールセンター", "サポートセンター", "連絡先"],
    answer:
      "au の総合案内は、au の携帯電話からは局番なしの「157」(無料)、" +
      "一般電話からは「0077-7-111」(無料)に発信します。" +
      "受付時間や混雑状況は変わることがあるため、最新情報は出典ページで確認してください。",
    sources: [
      { label: "au お問い合わせ(公式)", url: "https://www.au.com/support/inquiry/" }
    ],
    verified: false,
    lastVerified: null
  },
  {
    id: "shop-search",
    title: "au ショップ・店舗の検索と来店予約",
    keywords: ["ショップ", "店舗", "店", "auショップ", "来店", "予約", "近く", "場所", "どこ"],
    answer:
      "最寄りの au Style / au ショップの検索と来店予約は、au 公式の店舗検索ページから行えます。" +
      "店舗によって取扱業務や営業時間が異なるため、来店前に店舗ページで確認してください。",
    sources: [
      { label: "au ショップ検索(公式)", url: "https://www.au.com/aushop/" }
    ],
    verified: false,
    lastVerified: null
  },
  {
    id: "my-au",
    title: "契約内容・請求額の確認(My au)",
    keywords: ["My au", "myau", "マイエーユー", "契約内容", "請求", "料金確認", "支払い", "明細", "データ残量"],
    answer:
      "契約内容の確認・変更、請求額や明細、データ残量の確認は「My au」(Web / アプリ)から行えます。" +
      "ログインには au ID が必要です。",
    sources: [
      { label: "My au(公式)", url: "https://www.au.com/my-au/" }
    ],
    verified: false,
    lastVerified: null
  },
  {
    id: "trouble-repair",
    title: "故障・紛失・盗難時の対応",
    keywords: ["故障", "壊れた", "紛失", "なくした", "落とした", "盗難", "修理", "画面割れ", "水没"],
    answer:
      "端末の故障・紛失・盗難時は、au 公式のサポートページから状況別の手続き" +
      "(回線の一時停止、修理・交換の申し込みなど)を確認できます。" +
      "紛失・盗難の場合は不正利用防止のため、できるだけ早く回線停止の手続きをしてください。",
    sources: [
      { label: "au サポート(公式)", url: "https://www.au.com/support/" }
    ],
    verified: false,
    lastVerified: null
  },
  {
    id: "price-plan",
    title: "料金プランの一覧・確認",
    keywords: ["料金プラン", "プラン", "料金", "いくら", "値段", "使い放題", "ギガ"],
    answer:
      "au の現行の料金プラン(スマートフォン向けなど)は、au 公式サイトの料金・割引ページに一覧があります。" +
      "プラン名・料金・割引条件は改定されることがあるため、必ず出典ページで最新の内容を確認してください。",
    sources: [
      { label: "au 料金・割引(公式)", url: "https://www.au.com/mobile/charge/" }
    ],
    verified: false,
    lastVerified: null
  },
  {
    id: "au-pay",
    title: "au PAY(スマホ決済)",
    keywords: ["au PAY", "aupay", "エーユーペイ", "決済", "チャージ", "ポイント", "Ponta"],
    answer:
      "au PAY は KDDI のスマホ決済サービスです。使い方・チャージ方法・使える店舗などは" +
      "au PAY 公式サイトで案内されています。ポイントは Ponta ポイントと連携しています。",
    sources: [
      { label: "au PAY(公式)", url: "https://aupay.auone.jp/" }
    ],
    verified: false,
    lastVerified: null
  },
  {
    id: "brand-povo-uq",
    title: "povo・UQ mobile と au の関係",
    keywords: ["povo", "ポヴォ", "UQ", "UQモバイル", "uq mobile", "ブランド", "違い", "格安"],
    answer:
      "au・UQ mobile・povo はいずれも KDDI(および沖縄セルラー)が提供する通信ブランドです。" +
      "料金体系やサポート窓口はブランドごとに異なるため、各ブランドの公式サイトで確認してください。" +
      "このボットは au ブランドの案内を対象としています。",
    sources: [
      { label: "KDDI(公式)", url: "https://www.kddi.com/" },
      { label: "povo(公式)", url: "https://povo.jp/" },
      { label: "UQ mobile(公式)", url: "https://www.uqwimax.jp/mobile/" }
    ],
    verified: false,
    lastVerified: null
  },
  {
    id: "cancel-mnp",
    title: "解約・他社への乗り換え(MNP)",
    keywords: ["解約", "やめたい", "乗り換え", "MNP", "転出", "番号そのまま", "他社"],
    answer:
      "解約や MNP(番号を引き継いだ乗り換え)の手続き方法・注意点は、au 公式サポートの手続きページで案内されています。" +
      "契約内容によって解約時の費用や条件が異なるため、必ず出典ページと My au の契約内容を確認してください。",
    sources: [
      { label: "au サポート 各種手続き(公式)", url: "https://www.au.com/support/" }
    ],
    verified: false,
    lastVerified: null
  }
];
