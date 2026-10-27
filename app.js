(function () {
'use strict';
const NS = 'http://www.w3.org/2000/svg';
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const isReduce = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
const sleep = ms => new Promise(r => setTimeout(r, isReduce() ? 0 : ms));
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ---------------- theme ---------------- */
$('#themeBtn').addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('rm_theme', next); } catch (e) {}
});

/* ---------------- tabs ---------------- */
function showTab(which) {
  const sim = which === 'sim';
  $('#sim').hidden = !sim; $('#trouble').hidden = sim;
  $('#tabSim').setAttribute('aria-selected', sim); $('#tabTrouble').setAttribute('aria-selected', !sim);
  $('#tabSim').tabIndex = sim ? 0 : -1; $('#tabTrouble').tabIndex = sim ? -1 : 0;
}
$('#tabSim').addEventListener('click', () => showTab('sim'));
$('#tabTrouble').addEventListener('click', () => showTab('trouble'));
$('.tabs').addEventListener('keydown', e => {
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { const s = $('#tabSim').getAttribute('aria-selected') === 'true'; showTab(s ? 'trouble' : 'sim'); (s ? $('#tabTrouble') : $('#tabSim')).focus(); }
});

/* ---------------- state ---------------- */
let S, undoStack = [], busy = false, playing = false, msgDirty = false;
let selected = { remote: null, local: null };

function mkState() {
  return {
    seq: 4,
    commits: {
      c1: { id: 'c1', n: 1, hash: '3fa91c0', msg: 'プロジェクトを作成', parents: [], lane: 'main', by: 'team' },
      c2: { id: 'c2', n: 2, hash: 'b72e5d1', msg: 'README を追加', parents: ['c1'], lane: 'main', by: 'team' },
      c3: { id: 'c3', n: 3, hash: '8d04a6f', msg: 'ログイン画面の雛形', parents: ['c2'], lane: 'main', by: 'team' }
    },
    remote: { main: 'c3', feat: null },
    local: { main: null, feat: null, om: null, of: null, head: 'main' },
    cloned: false, hasBranch: false, branch: 'feature/login-button',
    wt: 'clean', diff: [], edits: 0,
    mr: null, ci: { sha: null, status: 'none', run: 0 },
    review: { state: 'none', sha: null },
    other: false, merged: false, mergeKind: null,
    did: {}, last: null,
    opts: { fail: false, squash: false, update: 'rebase' }
  };
}
const C = id => S.commits[id];
function reach(ids) {
  const seen = new Set(); const st = ids.filter(Boolean);
  while (st.length) { const x = st.pop(); if (seen.has(x)) continue; seen.add(x); C(x).parents.forEach(p => st.push(p)); }
  return seen;
}
const isAnc = (a, b) => reach([b]).has(a);
function fakeHash(n) {
  let t = (Math.imul(n, 0x9e3779b1) + 0x1234567) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (((t ^ (t >>> 14)) >>> 0).toString(16)).padStart(8, '0').slice(0, 7);
}
function newCommit(msg, parents, lane, by) {
  const n = S.seq++; const id = 'c' + n;
  S.commits[id] = { id, n, hash: fakeHash(n), msg, parents, lane, by: by || 'me' };
  return id;
}
function ciState(s) {
  if (!s.mr || !s.remote.feat) return 'none';
  return s.ci.sha === s.remote.feat ? s.ci.status : 'pending';
}
const behindCount = s => s.remote.feat ? [...reach([s.remote.main])].filter(x => !reach([s.remote.feat]).has(x)).length : 0;
const aheadCount = s => s.remote.feat ? [...reach([s.remote.feat])].filter(x => !reach([s.remote.main]).has(x)).length : 0;
const needForce = s => !!s.remote.feat && !isAnc(s.remote.feat, s.local.feat);
function ctxKind() {
  if (ciState(S) === 'failed') return 'fix';
  if (S.review.state === 'open' && S.remote.feat === S.review.sha) return 'review';
  return 'feature';
}
const qq = m => String(m).replace(/"/g, '\\"');

/* ---------------- actions ---------------- */
const A = {};
A.clone = {
  short: 'git clone', hint: 'まず git clone で、GitLab の中身を自分のPCにコピーします。',
  can: s => s.cloned ? 'もうクローン済みです。' : null,
  run(s) {
    s.cloned = true; s.local.main = s.remote.main; s.local.om = s.remote.main; s.local.head = 'main'; s.did.clone = 1;
    return { cmd: ['git clone https://gitlab.example.com/team/app.git'], title: 'クローン：GitLab の中身を自分のPCにコピー',
      text: ['GitLab にある「app」というリポジトリを、履歴ごと自分のPCに丸ごとコピーします。作業の最初に1回だけ行います。',
        'コピーされたのは main ブランチです。手元の main と、GitLab 側の位置を覚えておく印 origin/main が、同じ場所を指しています。',
        '作業フォルダにも、最新のファイルが取り出されました。'],
      fx: { from: 'remote', to: 'local', label: 'main のコピー' }, lanes: ['local', 'work'] };
  }
};
A.switch = {
  short: 'git switch -c', hint: 'main を直接いじらず、作業専用のブランチを作って移動します。',
  can: s => !s.cloned ? '先に git clone で、手元にコピーを作りましょう。' : s.hasBranch ? 'ブランチはもう作ってあります。' : null,
  run(s) {
    let name = ($('#branchIn').value || '').trim().replace(/[^A-Za-z0-9/_.-]/g, '-').replace(/\/{2,}/g, '/').replace(/^[-/.]+|[/.]+$/g, '');
    if (!name) name = 'feature/login-button';
    s.branch = name; s.local.feat = s.local.main; s.local.head = 'feat'; s.hasBranch = true; s.did.branch = 1;
    return { cmd: ['git switch -c ' + name], title: 'ブランチを作って、そこへ移動',
      text: ['main の隣に、自分専用の「' + name + '」という枝を作りました。-c は「作る(create)」の意味です。',
        '作った直後は main と同じ場所ですが、HEAD（いま自分が立っている場所の目印）は新しいブランチに移りました。',
        'こうしておけば、途中の作業で main を壊す心配がありません。'],
      fx: null, lanes: ['local', 'work'] };
  }
};
A.edit = {
  short: 'ファイルを編集', hint: null,
  can: s => !s.hasBranch ? '先にブランチを作りましょう（git switch -c）。' : s.merged ? 'マージが終わりました。次の作業は、新しいブランチで始めます。' :
    s.wt === 'modified' ? 'もう編集済みです。次は git add でステージに載せます。' : s.wt === 'staged' ? 'ステージ済みです。次は git commit で記録します。' : null,
  run(s) {
    const k = ctxKind(); s.edits++;
    s.diff = k === 'fix' ? ['- return total - tax;', '+ return total + tax;'] :
      k === 'review' ? ['- <button id="login">', '+ <button id="login-button">'] :
      s.did.commit ? ['+ <label>メールアドレス</label>'] : ['+ <button id="login">ログイン</button>', '+ <p class="hint">メールで登録</p>'];
    s.wt = 'modified'; s.did.edit = 1;
    return { cmd: ['# エディタで login.html を編集して保存', 'git status'], title: 'ファイルを編集：作業フォルダに「変更あり」',
      text: [k === 'fix' ? 'テストが失敗した原因（計算の間違い）を直しました。' : k === 'review' ? 'レビューの指摘に合わせて、id の名前を直しました。' : 'login.html を書き換えました。',
        '変更はまだ作業フォルダの中だけ。Git の履歴には入っていません。git status と打つと「変更あり」と表示されます。',
        '+ は追加した行、- は消した行です。'],
      fx: null, lanes: ['work'], pulse: true };
  }
};
A.add = {
  short: 'git add', hint: '変更を git add で、次のコミットに入れる「ステージ」に載せます。',
  can: s => s.wt === 'modified' ? null : s.wt === 'staged' ? 'もうステージ済みです。次は git commit。' : '先にファイルを編集しましょう（変更がありません）。',
  run(s) {
    s.wt = 'staged'; s.did.add = 1;
    return { cmd: ['git add login.html'], title: 'ステージ：次のコミットに入れる変更を選ぶ',
      text: ['編集した login.html を、「次のコミットに入れる物」を置く場所（ステージ）に移しました。',
        '複数のファイルを変えたとき、関係あるものだけを選んでコミットできるようにするための一段です。',
        '全部まとめて載せたいときは git add . と書きます。'],
      fx: { from: 'work', to: 'stage', label: 'login.html' }, lanes: ['work'] };
  }
};
A.commit = {
  short: 'git commit', hint: 'git commit で、ステージの変更を履歴に記録します。',
  can: s => s.wt === 'staged' ? null : s.wt === 'modified' ? '先に git add でステージに載せましょう。' : '記録する変更がありません。先に編集 → git add をしましょう。',
  run(s) {
    const msg = ($('#msgIn').value || '').trim() || suggestMsg();
    const id = newCommit(msg, [s.local.feat], 'feat'); s.local.feat = id; s.wt = 'clean'; s.diff = []; s.did.commit = 1; msgDirty = false;
    return { cmd: ['git commit -m "' + qq(msg) + '"'], title: 'コミット：変更を履歴に記録',
      text: ['ステージの内容が、ひとつの「コミット」（図の丸）になりました。横の英数字は、そのコミットの名札（ハッシュ）です。',
        '-m の後ろは、何を変えたかのメモ。あとで見て分かる文章にしましょう。',
        'まだ自分のPCの中だけ。点線の輪は「GitLab にはまだ無い」という印です。コミットは何回でも重ねられます。'],
      fx: { from: 'stage', to: 'local', label: 'commit ' + C(id).hash }, lanes: ['local', 'work'] };
  }
};
A.push = {
  short: 'git push', hint: null,
  can: s => !s.hasBranch ? '先にブランチを作ってコミットしましょう。' : s.merged ? 'このブランチは、もうマージ済みです。' :
    s.remote.feat === s.local.feat ? '送るコミットがありません。先に編集 → add → commit をしましょう。' : null,
  label: s => needForce(s) ? 'git push --force-with-lease' : s.local.of ? 'git push' : 'git push -u origin ' + s.branch,
  run(s) {
    const force = needForce(s), first = !s.local.of && !s.remote.feat, b = s.branch;
    s.remote.feat = s.local.feat; s.local.of = s.local.feat; s.did.push = 1;
    const cmd = force ? 'git push --force-with-lease' : first ? 'git push -u origin ' + b : 'git push';
    const text = first ? ['手元のコミットを GitLab へ送りました。リモートに、同じ名前のブランチ「' + b + '」ができます。',
        '-u は「このブランチは origin の同名ブランチとつなぐ」という設定。次からは git push だけで送れます。',
        '手元の origin/' + b + ' の印は、GitLab 側の位置を覚えているものです。点線の輪も消えました。'] :
      force ? ['rebase でコミットが付け替わった（名札が変わった）ので、GitLab のブランチを新しい履歴で上書きします。',
        '--force-with-lease は「自分が最後に見た状態のままなら上書きOK」という安全版の強制 push です。ただの --force は避けましょう。',
        '自分専用のブランチだけに使います。main には使いません。'] :
      ['新しいコミットを GitLab のブランチに足しました。',
        s.mr ? 'マージリクエストは自動で更新され、CI（自動テスト）も新しいコミットで予約されます。' : '次は、GitLab の画面でマージリクエストを作ります。',
        '送ったコミットの点線の輪が消えたのは、GitLab と手元が同じになった印です。'];
    return { cmd: [cmd], title: 'push：手元のコミットを GitLab へ送る', text, fx: { from: 'local', to: 'remote', label: 'push' }, lanes: ['remote', 'local'] };
  }
};
A.mr = {
  short: 'マージリクエスト', hint: 'GitLab の画面でマージリクエストを作り、「main に入れてもいい？」と依頼します。',
  can: s => !s.remote.feat ? '先に git push で、ブランチを GitLab へ送りましょう。' : s.mr ? 'マージリクエストはもう作ってあります。' : null,
  run(s) {
    s.mr = { title: ($('#mrTitle').value || '').trim() || 'ログインボタンを追加', desc: ($('#mrDesc').value || '').trim() };
    s.did.mr = 1;
    return { cmd: ['# GitLab の画面で「マージリクエストを作成」を押す'], title: 'マージリクエストを作る（GitLab の画面操作）',
      text: ['「' + s.branch + '」の変更を main に入れたい、という依頼ページを作りました。これはコマンドではなく GitLab 上の操作です。',
        'タイトルと説明には「何を・なぜ変えたか」を書きます。読む人が分かりやすいほど、レビューが早く終わります。',
        'ここから先、同じブランチに push するたびに、このページが自動で更新されます。'],
      fx: null, lanes: ['remote'] };
  }
};
A.ci = {
  short: 'CIを待つ', hint: 'push すると GitLab が自動でテストします。パイプラインの結果を見ましょう。',
  can: s => !s.mr ? '先にマージリクエストを作りましょう。' : s.merged ? 'マージ済みです。' :
    ciState(s) === 'passed' ? 'このコミットのパイプラインは、もう成功しています。' :
    ciState(s) === 'failed' ? '失敗しています。直して commit → push すると、自動でやり直されます。' : null,
  run(s) {
    const fail = s.opts.fail; s.opts.fail = false;
    s.ci = { sha: s.remote.feat, status: fail ? 'failed' : 'passed', run: s.ci.run + 1 };
    if (!fail) s.did.ciPass = 1;
    return { cmd: ['# push のあと、GitLab が自動で実行（設定ファイル: .gitlab-ci.yml）'], title: fail ? 'CI：test が失敗しました' : 'CI：build と test が成功しました',
      text: fail ? ['build は通りましたが、test の段階で失敗しました。マージ前に間違いが見つかる、まさに CI の役目です。',
        '直し方は、手元でファイルを直して → add → commit → push。同じマージリクエストでパイプラインが自動で再実行されます。',
        '失敗したままだと、マージのボタンは押せません。'] :
      ['push した内容を、GitLab が別のマシンで自動的に組み立て(build)て、テスト(test)しました。どちらも緑色で成功です。',
        '実際の GitLab では push した瞬間に自動で始まります。このボタンは、その待ち時間を見るためのものです。',
        '自分のPCだけでは気づけない問題を、マージの前に見つけてくれます。'],
      fx: null, lanes: ['remote'], ci: fail ? 'ng' : 'ok' };
  }
};
A.review = {
  short: 'レビュー', hint: 'CI が通りました。仲間にコードを読んでもらいます（レビュー）。',
  can: s => !s.mr ? '先にマージリクエストを作りましょう。' : s.merged ? 'マージ済みです。' : s.review.state !== 'none' ? 'レビューのコメントは、もう届いています。' :
    ciState(s) !== 'passed' ? 'まず CI が成功してから、レビューをお願いします。' : null,
  run(s) {
    s.review = { state: 'open', sha: s.remote.feat };
    return { cmd: ['# レビュアーが GitLab 上でコメントを書く'], title: 'コードレビュー：仲間からコメントが届いた',
      text: ['レビュアーが変更を読んで、気になる点にコメントを付けました。「未解決」のコメントがあるうちは、マージできません。',
        '直すときは、特別なことは要りません。手元でファイルを直して → add → commit → push するだけ。',
        '同じマージリクエストが自動で更新されるので、新しく作り直す必要はありません。'],
      fx: null, lanes: ['remote'] };
  }
};
A.resolve = {
  short: '解決済みにする', hint: '修正が push されました。コメントを「解決済み」にします。',
  can: s => s.review.state !== 'open' ? 'レビューのコメントが、まだありません。' : s.remote.feat === s.review.sha ? '先にコメントに対応して、修正コミットを push しましょう。' : null,
  run(s) {
    s.review.state = 'resolved'; s.did.resolve = 1;
    return { cmd: ['# GitLab の画面で「スレッドを解決」を押す'], title: 'コメントを解決済みにする',
      text: ['修正を push したので、コメントを「解決済み」にしました。（実際は、レビュアーが確認して閉じることも多いです。）',
        '未解決のコメントがなくなったので、マージの条件がそろいます。'], fx: null, lanes: ['remote'] };
  }
};
function mergeReason(s) {
  if (!s.mr) return '先にマージリクエストを作りましょう。';
  if (s.merged) return 'もうマージ済みです。';
  if (s.local.feat !== s.remote.feat || s.wt !== 'clean') return '手元の変更が、まだマージリクエストに入っていません。add → commit → push を終わらせましょう。';
  if (!isAnc(s.remote.main, s.remote.feat)) return 'main が先に進んでいます。先にブランチへ main を取り込んで（下の「おまけ」の手順）push しましょう。';
  if (ciState(s) !== 'passed') return 'CI が成功してからマージできます（パイプライン待ちか、失敗中です）。';
  if (s.review.state === 'open') return '未解決のレビューコメントがあります。直して push したあと「解決済みにする」を押しましょう。';
  return null;
}
A.merge = {
  short: '承認してマージ', hint: '条件がそろいました。承認して main にマージします。',
  can: mergeReason,
  run(s) {
    const sq = s.opts.squash; let id;
    if (sq) id = newCommit(s.mr.title, [s.remote.main], 'main', 'me');
    else id = newCommit("Merge branch '" + s.branch + "' into 'main'", [s.remote.main, s.remote.feat], 'main', 'me');
    s.remote.main = id; s.merged = true; s.mergeKind = sq ? 'squash' : 'merge'; s.did.merge = 1;
    return { cmd: ['# GitLab の画面で「承認 (Approve)」→「マージ」を押す'], title: sq ? 'マージ（スカッシュ）：コミットを1つにまとめて main へ' : 'マージ（マージコミット）：main に合流',
      text: sq ? ['ブランチの複数のコミットを、ひとつにまとめて main に入れました。main の履歴がすっきりします。',
        '元のコミットはブランチにだけ残るので、図では main と線がつながっていません。これが正しい姿です。',
        'GitLab 上の main だけが進みました。手元の main はまだ古いままです。'] :
      ['ブランチと main の2本の流れを合流させる「マージコミット」が、main に1つ増えました。',
        'ブランチの各コミットは、そのまま履歴に残ります。作業の経緯を細かく残したいときに向いています。',
        'GitLab 上の main だけが進みました。手元の main はまだ古いままなので、あとで git pull で追いつきます。'],
      fx: null, lanes: ['remote'] };
  }
};
A.deleteRemote = {
  short: 'ブランチを削除', hint: '使い終わったリモートのブランチを削除します。',
  can: s => !s.merged ? 'マージが終わってから消します。' : !s.remote.feat ? 'リモートのブランチは、もう削除済みです。' : null,
  run(s) {
    s.remote.feat = null; s.did.delRemote = 1;
    return { cmd: ['# GitLab の画面で「ソースブランチを削除」（マージ時のチェックでもOK）', '# コマンドなら: git push origin --delete ' + s.branch], title: 'リモートのブランチを削除',
      text: ['マージ済みのブランチは役目を終えたので、GitLab から消します。消えるのは「枝の名札」だけで、履歴（コミット）は main に残ります。',
        '放っておくと古いブランチがたまって、どれが現役か分からなくなります。'], fx: null, lanes: ['remote'] };
  }
};
A.switchMain = {
  short: 'git switch main', hint: 'main に戻ります（git switch main）。',
  can: s => !s.merged ? 'マージが終わってから、main に戻ります。' : s.local.head === 'main' ? 'もう main にいます。' : null,
  run(s) {
    s.local.head = 'main';
    return { cmd: ['git switch main'], title: 'main に戻る',
      text: ['作業の場所を main に戻しました。HEAD の目印が main に移っています。',
        'ただし手元の main は、まだ古いまま。GitLab で main が進んだ分は、まだ取り込んでいません。次は git pull です。'], fx: null, lanes: ['local', 'work'] };
  }
};
A.pull = {
  short: 'git pull', hint: 'git pull で、手元の main を GitLab の最新に追いつかせます。',
  can: s => !s.merged ? 'マージが終わってから行います。' : s.local.head !== 'main' ? '先に git switch main で main に戻りましょう（いまはブランチの上です）。' :
    (s.local.main === s.remote.main && !(s.local.of && !s.remote.feat)) ? 'もう最新です。' : null,
  run(s) {
    s.local.main = s.remote.main; s.local.om = s.remote.main; if (!s.remote.feat) s.local.of = null; s.did.pull = 1;
    return { cmd: ['git pull --prune'], title: 'pull：GitLab の最新を手元の main に取り込む',
      text: ['GitLab の main の新しいコミットを手元に取り込み、手元の main が追いつきました。これで main の三者(手元・origin/main・GitLab)がそろいます。',
        'pull は「fetch（取ってくる）＋ merge（合わせる）」を一度にやるコマンドです。',
        '--prune は、GitLab で消えたブランチの印（origin/…）も掃除してくれる指定です。'],
      fx: { from: 'remote', to: 'local', label: 'main の更新' }, lanes: ['local', 'work'] };
  }
};
A.branchD = {
  short: 'git branch -d', hint: '手元の使い終わったブランチを消します。',
  label: s => s.mergeKind === 'squash' ? 'git branch -D ' + s.branch : 'git branch -d ' + s.branch,
  can: s => !s.merged ? 'マージが終わってから消します。' : !s.local.feat ? '手元のブランチは、もう削除済みです。' : s.local.head !== 'main' ? 'いま居るブランチは消せません。先に git switch main。' :
    s.local.main !== s.remote.main ? 'まだ手元の main が古いです。先に git pull で最新にしましょう。' : null,
  run(s) {
    const sq = s.mergeKind === 'squash';
    s.local.feat = null; s.did.branchD = 1;
    return { cmd: [sq ? 'git branch -D ' + s.branch : 'git branch -d ' + s.branch], title: '手元のブランチを削除',
      text: sq ? ['手元のブランチを消しました。スカッシュでは、元のコミットが main に入っていない形になるため、Git が「未マージ」と判断します。',
        'そのため小文字の -d は拒否され、「強制的に消す」大文字の -D を使います。内容は main に入っているので安心してください。',
        'これで一周完了。次の作業は、また新しいブランチから始めます。'] :
      ['手元のブランチを消しました。小文字の -d は「main に入ったものだけ消す」安全版です。入っていなければ Git が止めてくれます。',
        'ブランチの名札が消えただけで、コミットは main の履歴に残っています。',
        'これで一周完了。次の作業は、また新しいブランチから始めます。'], fx: null, lanes: ['local'] };
  }
};
A.other = {
  short: '先にmainが更新された', hint: null,
  can: s => !s.hasBranch ? '先にブランチを作ってから、作業中に main が進む場面を体験しましょう。' : s.merged ? 'マージ済みなので、いまは試せません。' : s.other ? 'もう実行済みです。続けて git fetch へ進みましょう。' : null,
  run(s) {
    const id = newCommit('README の誤字を修正（ほかの人）', [s.remote.main], 'main', 'other');
    s.remote.main = id; s.other = true;
    return { cmd: ['# ほかの人が、GitLab の main に変更を push した'], title: 'ほかの人が先に main を更新した',
      text: ['チームで開発していると、自分が作業している間に、別の人の変更が先に main に入ることがよくあります。',
        '紫の丸が、ほかの人のコミットです。GitLab の main だけが進みました。手元はまだ気づいていません。',
        '自分のブランチは、古い main を元にした状態です。まず git fetch で、手元に知らせましょう。'],
      fx: { from: 'other', to: 'remote', label: 'ほかの人の push' }, lanes: ['remote'] };
  }
};
A.fetch = {
  short: 'git fetch', hint: null,
  can: s => !s.cloned ? '先に git clone をしましょう。' : s.local.om === s.remote.main ? '手元の origin/main は、もう最新です。（まず「ほかの人が先に main を更新した」を押すと変化が見えます）' : null,
  run(s) {
    s.local.om = s.remote.main;
    return { cmd: ['git fetch origin'], title: 'fetch：GitLab の最新を「見に行く」',
      text: ['GitLab の新しい情報を手元に取ってきました。origin/main の印だけが動いて、ほかの人のコミットが見えるようになります。',
        '手元の main や、作業中のファイルは何も変わりません。だから安全に使えます（pull は、これに「合わせる」までを一度にやります）。',
        '次は、この最新の main を、自分のブランチに取り込みます。'],
      fx: { from: 'remote', to: 'local', label: 'fetch' }, lanes: ['local'] };
  }
};
A.update = {
  short: '取り込む', hint: null,
  label: s => s.opts.update === 'rebase' ? 'git rebase origin/main' : 'git merge origin/main',
  can: s => !s.hasBranch ? '先にブランチを作りましょう。' : s.merged ? 'マージ済みです。' : s.wt !== 'clean' ? 'コミットしていない変更があります。先にコミットしましょう。' :
    isAnc(s.local.om, s.local.feat) ? '取り込む物がありません。先に git fetch で、最新の origin/main を手元に取ってきましょう。' : null,
  run(s) {
    s.did.update = 1;
    if (s.opts.update === 'rebase') {
      const mine = [...reach([s.local.feat])].filter(x => !reach([s.local.om]).has(x)).sort((a, b) => C(a).n - C(b).n);
      let parent = s.local.om;
      mine.forEach(x => { parent = newCommit(C(x).msg, [parent], 'feat'); });
      s.local.feat = parent;
      return { cmd: ['git rebase origin/main'], title: 'rebase：最新の main の先頭に付け替える',
        text: ['自分のコミットを、最新の main の後ろに「付け替え」ました。履歴が一直線になって読みやすくなります。',
          '付け替えたコミットは名札(ハッシュ)が変わります。うすい丸が古い方で、すでに push 済みなら GitLab にはまだ古い方があります。',
          'そのため、このあとの push には --force-with-lease が必要です。（実際は、ここで衝突が起きることもあります。「よくあるつまずき」を見てください）'],
        fx: null, lanes: ['local'] };
    }
    const id = newCommit("Merge branch 'main' into " + s.branch, [s.local.feat, s.local.om], 'feat');
    s.local.feat = id;
    return { cmd: ['git merge origin/main'], title: 'merge：main の変更を自分のブランチに合流',
      text: ['最新の main を、自分のブランチに合流させました。合流の印として、マージコミットが1つ増えます。',
        '既存のコミットは書き換わらないので、このあとは普通の git push でOKです。rebase との違いは、履歴が枝分かれの形のまま残る点です。',
        '（実際は、ここで衝突が起きることもあります。「よくあるつまずき」を見てください）'],
      fx: null, lanes: ['local'] };
  }
};

const STEP_OF = { clone: 1, switch: 2, edit: 3, add: 4, commit: 5, push: 6, mr: 7, ci: 8, review: 9, resolve: 9, merge: 10, deleteRemote: 11, switchMain: 11, pull: 11, branchD: 11, other: 12, fetch: 12, update: 12 };
const STEPS = [
  { n: 1, t: 'クローン', d: 'GitLab 上のコピーを自分のPCに作る', acts: [['clone', 'git clone']] },
  { n: 2, t: 'ブランチを作る', d: 'main を直接いじらず、作業専用の「枝」を作る', ex: 'branch', acts: [['switch', 'git switch -c']] },
  { n: 3, t: 'ファイルを編集', d: '作業フォルダのファイルを書き換える', acts: [['edit', 'ファイルを編集', 1]] },
  { n: 4, t: 'ステージする', d: '次のコミットに入れる変更を選ぶ', acts: [['add', 'git add login.html']] },
  { n: 5, t: 'コミットする', d: '変更をひとまとめにして履歴に記録（何回でもOK）', ex: 'msg', acts: [['commit', 'git commit -m']] },
  { n: 6, t: 'GitLab へ送る (push)', d: '手元のコミットを GitLab に送る', acts: [['push', 'git push']] },
  { n: 7, t: 'マージリクエストを作る', d: '「main に入れていい？」とチームに依頼', acts: [['mr', 'マージリクエストを作成', 1]] },
  { n: 8, t: 'CI（自動テスト）', d: '壊れていないか、自動で確認してもらう', ex: 'ci', acts: [['ci', 'パイプラインを実行', 1]] },
  { n: 9, t: 'コードレビュー', d: '仲間が読んでコメント。直したら push するだけ', opt: 1, acts: [['review', 'レビュアーがコメント', 1], ['resolve', '解決済みにする', 1]] },
  { n: 10, t: '承認してマージ', d: 'OKが出たら main に合流', ex: 'merge', acts: [['merge', '承認してマージ', 1]] },
  { n: 11, t: '後片付け', d: '枝を消して、手元の main を最新にする', acts: [['deleteRemote', 'リモートのブランチを削除', 1], ['switchMain', 'git switch main'], ['pull', 'git pull'], ['branchD', 'git branch -d']] },
  { n: 12, t: 'おまけ：先に main が進んだら', d: '作業中にほかの人が main を更新したときの対応', opt: 1, ex: 'update', acts: [['other', 'ほかの人が先に main を更新', 1], ['fetch', 'git fetch'], ['update', 'git rebase']] }
];
function buildSteps() {
  const ol = $('#stepList');
  STEPS.forEach(st => {
    const li = document.createElement('li'); li.className = 'step'; li.dataset.n = st.n;
    let h = '<div class="s-head"><span class="num">' + st.n + '</span><div><span class="s-title">' + st.t + (st.opt ? '<span class="opt">任意</span>' : '') + '</span><span class="s-desc">' + st.d + '</span></div><span class="here">いまここ</span></div><div class="s-body">';
    if (st.ex === 'branch') h += '<input class="s-in mono" id="branchIn" type="text" value="feature/login-button" maxlength="26" aria-label="ブランチ名" spellcheck="false" autocapitalize="off">';
    if (st.ex === 'msg') h += '<input class="s-in" id="msgIn" type="text" maxlength="40" aria-label="コミットメッセージ">';
    if (st.ex === 'ci') h += '<div class="s-opt" role="radiogroup" aria-label="テスト結果"><span>結果：</span><label><input type="radio" name="ciopt" value="ok" checked>成功</label><label><input type="radio" name="ciopt" value="fail">テスト失敗</label></div>';
    if (st.ex === 'merge') h += '<div class="s-opt" role="radiogroup" aria-label="マージ方法"><label><input type="radio" name="mgopt" value="merge" checked>マージコミット</label><label><input type="radio" name="mgopt" value="squash">スカッシュ</label></div>';
    if (st.ex === 'update') h += '<div class="s-opt" role="radiogroup" aria-label="取り込み方"><span>取り込み方：</span><label><input type="radio" name="upopt" value="rebase" checked>rebase</label><label><input type="radio" name="upopt" value="merge">merge</label></div>';
    st.acts.forEach(a => { h += '<button type="button" class="sbtn' + (a[2] ? ' jp' : '') + '" data-act="' + a[0] + '" aria-disabled="true">' + a[1] + '</button>'; });
    li.innerHTML = h + '</div>'; ol.appendChild(li);
  });
  $$('input[name=ciopt]').forEach(r => r.addEventListener('change', () => { S.opts.fail = r.value === 'fail'; }));
  $$('input[name=mgopt]').forEach(r => r.addEventListener('change', () => { S.opts.squash = r.value === 'squash'; }));
  $$('input[name=upopt]').forEach(r => r.addEventListener('change', () => { S.opts.update = r.value; renderSteps(); }));
  $('#msgIn').addEventListener('input', () => { msgDirty = true; });
  $('#stepList').addEventListener('click', e => { const b = e.target.closest('[data-act]'); if (b) perform(b.dataset.act); });
}
function suggestMsg() {
  const k = ctxKind();
  if (k === 'fix') return 'テストの失敗を修正';
  if (k === 'review') return 'レビューの指摘を修正';
  return S.did.commit ? '変更を追加' : 'ログインボタンを追加';
}

/* recommended next action */
function rec(s) {
  const r = (act, hint) => ({ act, hint: hint || A[act].hint });
  if (!s.cloned) return r('clone');
  if (!s.hasBranch) return r('switch');
  if (s.merged) {
    if (s.remote.feat) return r('deleteRemote');
    if (s.local.head !== 'main') return r('switchMain');
    if (s.local.main !== s.remote.main || (s.local.of && !s.remote.feat)) return r('pull');
    if (s.local.feat) return r('branchD');
    return null;
  }
  if (s.wt === 'staged') return r('commit');
  if (s.wt === 'modified') return r('add');
  if (!s.did.commit) return r('edit', 'ファイルを編集して、変更を作りましょう。');
  if (s.other && !isAnc(s.remote.main, s.local.feat)) return s.local.om !== s.remote.main ? r('fetch', 'ほかの人の変更を、まず git fetch で手元に知らせます。') : r('update', 'fetch した最新の main を、自分のブランチに取り込みます。');
  if (s.remote.feat !== s.local.feat) return r('push', needForce(s) ? '付け替えたので、--force-with-lease で GitLab のブランチを更新します。' : s.remote.feat ? '新しいコミットを GitLab へ push します。' : 'コミットを GitLab へ送りましょう（push）。');
  if (!s.mr) return r('mr');
  const cs = ciState(s);
  if (cs === 'pending' || cs === 'none') return r('ci');
  if (cs === 'failed') return r('edit', 'CI が失敗しました。直すために、まずファイルを編集します。');
  if (s.review.state === 'none') return r('review');
  if (s.review.state === 'open') return s.remote.feat === s.review.sha ? r('edit', 'レビューの指摘に対応するため、ファイルを編集します。') : r('resolve');
  return r('merge');
}
function why(act) {
  if (busy) return 'いま動いています。少し待ってね。';
  return A[act].can(S);
}

/* ---------------- perform ---------------- */
function snapshot() { return JSON.parse(JSON.stringify(S)); }
async function perform(act, o) {
  if (busy) return;
  if (playing && !(o && o.auto)) { showNote('おまかせ再生中です。「停止」を押すと、自分で操作できます。'); return; }
  const reason = A[act].can(S);
  if (reason) { showNote('まだ押せません：' + reason); return; }
  busy = true; document.body.dataset.busy = '1';
  try {
    undoStack.push(snapshot()); if (undoStack.length > 120) undoStack.shift();
    const info = A[act].run(S);
    S.last = { act, step: STEP_OF[act], cmd: info.cmd, title: info.title, text: info.text };
    showNote('');
    renderExplain(); flashLanes(info.lanes);
    if (info.fx) await fly(info.fx.from, info.fx.to, info.fx.label);
    if (info.ci) await animCI();
    renderAll();
    if (info.pulse) { const f = $('#fileCard'); f.classList.remove('pulse'); void f.offsetWidth; f.classList.add('pulse'); }
  } finally { busy = false; delete document.body.dataset.busy; renderControls(); }
}
function flashLanes(ls) {
  const map = { remote: '#laneRemote', local: '#laneLocal', work: '#laneWork' };
  Object.keys(map).forEach(k => $(map[k]).classList.remove('flash'));
  void document.body.offsetWidth;
  (ls || []).forEach(k => $(map[k]).classList.add('flash'));
}
const FX = { remote: '#boxRemote', local: '#boxLocal', work: '#fileCard', stage: '#zoneStage', other: '#laneRemote .lane-h' };
function fly(from, to, label) {
  if (isReduce()) return Promise.resolve();
  const a = $(FX[from]), b = $(FX[to]); if (!a || !b) return Promise.resolve();
  const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
  const p = document.createElement('div'); p.className = 'packet'; p.textContent = label; document.body.appendChild(p);
  const w = p.offsetWidth, h = p.offsetHeight;
  const x0 = ra.left + ra.width / 2 - w / 2, y0 = ra.top + Math.min(ra.height / 2, 80) - h / 2;
  const x1 = rb.left + rb.width / 2 - w / 2, y1 = rb.top + Math.min(rb.height / 2, 80) - h / 2;
  const an = p.animate([{ transform: `translate(${x0}px,${y0}px)`, opacity: 0 }, { opacity: 1, offset: .15 }, { opacity: 1, offset: .85 }, { transform: `translate(${x1}px,${y1}px)`, opacity: 0 }], { duration: 950, easing: 'ease-in-out' });
  return an.finished.then(() => p.remove(), () => p.remove());
}
async function animCI() {
  const b = $('#stBuild'), t = $('#stTest'); $('#mr').hidden = false; $('#mrAfter').hidden = false;
  setStage(b, 'running'); setStage(t, 'idle'); $('#pipeState').textContent = '実行中…';
  await sleep(1000); setStage(b, 'ok'); setStage(t, 'running'); await sleep(1100);
}
function setStage(el, st) { el.dataset.state = st; }

function showNote(t) { const n = $('#note'); n.textContent = t; n.hidden = !t; }

/* undo / reset / autoplay */
$('#undoBtn').addEventListener('click', async () => {
  if (busy || !undoStack.length) return;
  playing = false; S = undoStack.pop(); msgDirty = false; showNote(''); renderAll(); renderExplain();
});
$('#resetBtn').addEventListener('click', async () => {
  playing = false; while (busy) await sleep(30);
  S = mkState(); undoStack = []; msgDirty = false; selected = { remote: null, local: null };
  $('#branchIn').value = 'feature/login-button'; showNote(''); renderAll(); renderExplain();
});
$('#nextBtn').addEventListener('click', () => { if (busy || playing) return; const r = rec(S); if (r) perform(r.act); });
$('#autoBtn').addEventListener('click', async () => {
  if (playing) { playing = false; renderControls(); return; }
  if (busy || !rec(S)) return;
  playing = true; renderControls();
  while (playing) {
    const r = rec(S); if (!r) break;
    await perform(r.act, { auto: true });
    if (!playing) break;
    await sleep(1700);
  }
  playing = false; renderControls();
});

/* ---------------- rendering ---------------- */
function renderAll() {
  renderGraph('remote'); renderGraph('local'); renderWork(); renderMR(); renderSteps(); renderControls();
}
function renderExplain() {
  const L = S.last, cmd = $('#exCmd');
  if (!L) {
    $('#exTag').textContent = 'はじめに'; cmd.hidden = true;
    $('#exTitle').textContent = 'ボタンを押すと、ここに「実行されるコマンド」と説明が出ます';
    $('#exText').innerHTML = '<p>「つぎへ」ボタン、または手順一覧のボタンを、上から順に押してみましょう。押すたびに、下の3つの場所（リモート・ローカル・作業フォルダ）の絵が動きます。</p><p>押せないボタンは、薄く表示されます。押すと「先に何をすればいいか」が出ます。</p>';
  } else {
    $('#exTag').textContent = 'ステップ ' + L.step + '：' + STEPS[L.step - 1].t;
    cmd.hidden = false;
    cmd.innerHTML = L.cmd.map(l => l.charAt(0) === '#' ? '<span class="c">' + esc(l) + '</span>' : '<span class="p">$ </span>' + esc(l)).join('\n');
    $('#exTitle').textContent = L.title;
    $('#exText').innerHTML = L.text.map(t => '<p>' + esc(t) + '</p>').join('');
  }
  { const cs = L ? L.cmd.filter(l => l[0] !== '#') : []; $('#tbLast').textContent = !L ? '' : cs.length ? '$ ' + cs.join(' ; ') : L.title; }
  renderHint();
}
function renderHint() {
  const r = rec(S), h = $('#exHint');
  if (r) h.innerHTML = '<b>つぎは：</b>' + esc(r.hint);
  else if (!S.cloned) h.textContent = '';
  else h.innerHTML = '<b>ひと通り完了です。</b>「リセット」で最初から。2回目は、「テスト失敗」や「先に main が進んだ」場面も試してみましょう。';
}

/* graph */
let SP = 46; const LEFT = 24, YS = [84, 120, 158], GH = 222, PH = 18, PS = 20;
const gs = {};
function mk(tag, attrs, parent) { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; }
function initGraph(which, svg) {
  svg.innerHTML = '';
  gs[which] = { svg, edges: new Map(), nodes: new Map(), labels: new Map(), le: mk('g', {}, svg), ln: mk('g', {}, svg), ll: mk('g', {}, svg) };
}
function leave(el) {
  el.classList.add('leave'); if (isReduce()) el.remove(); else setTimeout(() => el.remove(), 380);
}
function depthFn() { const m = {}; const d = id => (id in m) ? m[id] : (m[id] = C(id).parents.length ? 1 + Math.max(...C(id).parents.map(d)) : 0); return d; }
function refsFor(which) {
  const R = S.remote, L = S.local, o = [], b = S.branch;
  if (which === 'remote') { o.push({ c: R.main, key: 'main', text: 'main', cls: 'main', pri: 0 }); if (R.feat) o.push({ c: R.feat, key: 'feat', text: b, cls: 'feat', pri: 1 }); return o; }
  if (L.main) o.push({ c: L.main, key: 'main', text: (L.head === 'main' ? 'HEAD → ' : '') + 'main', cls: 'main' + (L.head === 'main' ? ' head' : ''), pri: L.head === 'main' ? 0 : 2 });
  if (L.feat) o.push({ c: L.feat, key: 'feat', text: (L.head === 'feat' ? 'HEAD → ' : '') + b, cls: 'feat' + (L.head === 'feat' ? ' head' : ''), pri: L.head === 'feat' ? 0 : 2 });
  if (L.om) o.push({ c: L.om, key: 'om', text: 'origin/main', cls: 'main remote', pri: 3 });
  if (L.of) o.push({ c: L.of, key: 'of', text: 'origin/' + b, cls: 'feat remote', pri: 4 });
  return o;
}
function renderGraph(which) {
  const G = gs[which], R = S.remote, L = S.local, box = $(which === 'remote' ? '#boxRemote' : '#boxLocal');
  const tips = which === 'remote' ? [R.main, R.feat] : [L.main, L.feat, L.om, L.of];
  const vis = reach(tips); const ids = [...vis].sort((a, b) => C(a).n - C(b).n);
  const prim = which === 'remote' ? R.feat : (L.feat || L.of); const primSet = prim ? reach([prim]) : null;
  const remSet = which === 'local' ? reach([R.main, R.feat]) : null;
  const dep = depthFn(), pos = {};
  { let md = 1; ids.forEach(id => { md = Math.max(md, dep(id)); }); SP = Math.max(38, Math.min(52, Math.floor(((box.clientWidth || 320) - LEFT - 150) / md))); }
  ids.forEach(id => { const c = C(id); const row = c.lane === 'main' ? 0 : (primSet && !primSet.has(id) ? 1 : 2); pos[id] = { x: LEFT + dep(id) * SP, y: YS[row], row }; });
  let maxX = 0; ids.forEach(id => { maxX = Math.max(maxX, pos[id].x); });

  // edges
  const wantE = new Set();
  ids.forEach(id => C(id).parents.forEach(p => {
    const key = p + '>' + id; wantE.add(key);
    let e = G.edges.get(key);
    if (!e) { e = mk('path', { pathLength: 1, class: 'edge enter' }, G.le); G.edges.set(key, e); }
    const a = pos[p], b = pos[id];
    e.setAttribute('d', a.y === b.y ? `M${a.x} ${a.y}L${b.x} ${b.y}` : `M${a.x} ${a.y}C${a.x + 26} ${a.y},${b.x - 26} ${b.y},${b.x} ${b.y}`);
    e.classList.toggle('feat', C(id).lane === 'feat' || C(p).lane === 'feat'); e.classList.toggle('main', !(C(id).lane === 'feat' || C(p).lane === 'feat'));
    e.classList.toggle('ghost', pos[id].row === 1 || (pos[p].row === 1));
  }));
  G.edges.forEach((e, k) => { if (!wantE.has(k)) { G.edges.delete(k); leave(e); } });

  // nodes
  const wantN = new Set(ids);
  ids.forEach(id => {
    const c = C(id); let g = G.nodes.get(id);
    if (!g) {
      g = mk('g', { class: 'node enter', tabindex: 0, role: 'button' }, G.ln);
      mk('circle', { class: 'ring', r: 13 }, g); mk('circle', { class: 'dot', r: 8 }, g);
      const t = mk('text', { class: 'hash' }, g); t.textContent = c.hash;
      const ti = mk('title', {}, g); ti.textContent = c.hash + ' ' + c.msg;
      g.setAttribute('aria-label', 'コミット ' + c.hash + ' ' + c.msg);
      g.addEventListener('click', () => selectCommit(which, id));
      g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectCommit(which, id); } });
      G.nodes.set(id, g);
    }
    const p = pos[id]; g.style.transform = `translate(${p.x}px,${p.y}px)`;
    $('text', g).setAttribute('y', p.row === 0 ? 24 : p.row === 1 ? 22 : -14);
    g.classList.toggle('lane-main', c.lane === 'main'); g.classList.toggle('lane-feat', c.lane === 'feat'); g.classList.toggle('by-other', c.by === 'other');
    g.classList.toggle('ghost', p.row === 1); g.classList.toggle('sel', selected[which] === id);
    g.classList.toggle('local-only', !!remSet && !remSet.has(id));
  });
  G.nodes.forEach((g, id) => { if (!wantN.has(id)) { G.nodes.delete(id); leave(g); } });

  // labels
  const items = refsFor(which).filter(r => pos[r.c]);
  const byC = {}; items.forEach(r => { (byC[r.c] = byC[r.c] || []).push(r); });
  const groups = Object.keys(byC).map(id => ({ id, p: pos[id], items: byC[id].sort((a, b) => a.pri - b.pri) })).sort((a, b) => a.p.x - b.p.x);
  const boxes = [[], [], []]; const place = {}; let maxR = maxX;
  groups.forEach(g => {
    const row = g.p.row;
    for (let s = 0; s < 8; s++) {
      const rects = g.items.map((it, k) => {
        const w = Math.round(6.8 * it.text.length + 14), kk = k + s;
        const x0 = row === 1 ? g.p.x + 14 : g.p.x - 8;
        const top = row === 0 ? g.p.y - 16 - PH - kk * PS : row === 2 ? g.p.y + 16 + kk * PS : g.p.y - PH / 2 + kk * PS;
        return { it, x0, x1: x0 + w, top, bot: top + PH, w };
      });
      const clash = rects.some(a => boxes[row].some(b => a.x0 < b.x1 + 3 && b.x0 < a.x1 + 3 && a.top < b.bot + 2 && b.top < a.bot + 2));
      if (!clash || s === 7) { rects.forEach(r => { place[r.it.key] = r; boxes[row].push(r); maxR = Math.max(maxR, r.x1); }); break; }
    }
  });
  const wantL = new Set();
  items.forEach(it => {
    const r = place[it.key]; if (!r) return; wantL.add(it.key);
    let g = G.labels.get(it.key);
    if (!g) {
      g = mk('g', { class: 'pill enter' }, G.ll); mk('rect', { x: 0, y: 0, height: PH }, g);
      const t = mk('text', { x: 7, y: 13 }, g); G.labels.set(it.key, g);
    }
    g.setAttribute('class', 'pill ' + it.cls + (g.classList.contains('enter') ? ' enter' : ''));
    g.style.transform = `translate(${r.x0}px,${r.top}px)`;
    const rc = $('rect', g); rc.setAttribute('width', r.w); $('text', g).textContent = it.text;
  });
  G.labels.forEach((g, k) => { if (!wantL.has(k)) { G.labels.delete(k); leave(g); } });

  const width = Math.max(box.clientWidth, maxR + 16);
  G.svg.setAttribute('width', width); G.svg.setAttribute('height', GH);
  box.scrollTo({ left: box.scrollWidth, behavior: isReduce() ? 'auto' : 'smooth' });
  if (which === 'local') $('#emptyLocal').hidden = S.cloned;
  // caption
  const sel = selected[which]; const cap = $(which === 'remote' ? '#capRemote' : '#capLocal');
  if (sel && vis.has(sel)) { const c = C(sel); cap.innerHTML = '<b>' + c.hash + '</b>「' + esc(c.msg) + '」 作った人：' + (c.by === 'other' ? 'ほかの人' : c.by === 'team' ? 'チーム' : '自分'); }
  else { selected[which] = null; cap.textContent = which === 'remote' ? '丸を押すと、コミットの内容が見えます。' : '丸の点線の輪は「まだ GitLab に送っていないコミット」です。'; }
}
function selectCommit(which, id) { selected[which] = id; renderGraph(which); }

function renderWork() {
  $('#emptyWork').hidden = S.cloned; $('#workBody').hidden = !S.cloned;
  $('#curBranch').textContent = S.local.head === 'main' ? 'main' : S.branch;
  const f = $('#fileCard'), mod = S.wt === 'modified';
  f.dataset.state = mod ? 'modified' : 'clean'; $('#fileTag').textContent = mod ? '変更あり（未ステージ）' : S.wt === 'staged' ? '変更なし（ステージへ移動）' : '変更なし';
  const fd = $('#fileDiff'); fd.hidden = !mod; fd.innerHTML = fmtDiff(S.diff);
  $('#stageCard').hidden = S.wt !== 'staged'; $('#stageEmpty').hidden = S.wt === 'staged'; $('#stageDiff').innerHTML = fmtDiff(S.diff);
}
const fmtDiff = d => d.map(l => '<span class="' + (l[0] === '+' ? 'add' : 'del') + '">' + esc(l) + '</span>').join('\n');

function renderMR() {
  const mr = $('#mr'); const show = !!S.remote.feat || !!S.mr;
  mr.hidden = !show;
  if (!show) return;
  const created = !!S.mr;
  $('#mrSrc').textContent = S.branch;
  $('#mrTitle').readOnly = created; $('#mrDesc').readOnly = created;
  if (created) { $('#mrTitle').value = S.mr.title; $('#mrDesc').value = S.mr.desc; }
  const b = $('#mrBadge'); b.className = 'badge' + (S.merged ? ' merged' : created ? ' open' : ''); b.textContent = S.merged ? 'マージ済み' : created ? 'オープン' : '新規（まだ作成前）';
  $('#mrAfter').hidden = !created;
  if (!S.remote.feat && !created) return;
  $('#mrCount').textContent = S.remote.feat && !S.merged ? 'コミット ' + aheadCount(S) + ' 件' : '';
  if (!created) return;
  const cs = ciState(S), sb = $('#stBuild'), st = $('#stTest');
  {
    if (cs === 'passed') { setStage(sb, 'ok'); setStage(st, 'ok'); }
    else if (cs === 'failed') { setStage(sb, 'ok'); setStage(st, 'ng'); }
    else { setStage(sb, 'idle'); setStage(st, 'idle'); }
  }
  $('#pipeId').textContent = S.ci.run ? '#' + (1000 + S.ci.run) + (S.ci.sha ? ' ' + (C(S.ci.sha) ? C(S.ci.sha).hash : '') : '') : '';
  const ps = $('#pipeState'); ps.textContent = { passed: '成功', failed: '失敗', pending: '未実行（新しいコミット待ち）', none: '' }[cs] || '';
  ps.style.color = cs === 'passed' ? 'var(--ok)' : cs === 'failed' ? 'var(--ng)' : 'var(--muted)';
  const th = $('#thread'); th.hidden = S.review.state === 'none';
  if (S.review.state !== 'none') {
    const t = $('#thState'); t.textContent = S.review.state === 'open' ? '未解決' : '解決済み'; t.className = 'badge ' + (S.review.state === 'open' ? 'ng' : 'open');
    $('#thNote').textContent = S.review.state === 'resolved' ? '' : (S.remote.feat !== S.review.sha ? '修正コミットが push されました。確認して解決済みにできます。' : '');
  }
  if (S.merged) { $('#checks').innerHTML = ''; const r = $('#mrReady'); r.className = 'ready ok'; r.textContent = (S.mergeKind === 'squash' ? 'スカッシュして' : 'マージコミットで') + ' main に入りました。'; return; }
  const behind = behindCount(S), unres = S.review.state === 'open';
  const rows = [
    [cs === 'passed', 'パイプライン：' + ({ passed: '成功', failed: '失敗', pending: '未実行', none: '未実行' }[cs])],
    [!unres, '未解決のコメント：' + (unres ? '1 件' : 'なし')],
    [behind === 0, 'main との差：' + (behind === 0 ? '最新' : 'main が ' + behind + ' コミット先に進んでいます')]
  ];
  $('#checks').innerHTML = rows.map(r => '<li class="' + (r[0] ? 'ok' : 'ng') + '"><span class="mk" aria-hidden="true">' + (r[0] ? '✓' : '×') + '</span><span>' + esc(r[1]) + '</span></li>').join('');
  const rd = $('#mrReady'), ok = rows.every(r => r[0]);
  rd.className = 'ready ' + (ok ? 'ok' : 'ng'); rd.textContent = ok ? 'マージできます（手元の push 漏れが無ければ）' : 'まだマージできません';
}

function renderSteps() {
  const r = rec(S), cur = r ? STEP_OF[r.act] : 0;
  const done = doneMap();
  $$('.step').forEach(li => {
    const n = +li.dataset.n; li.classList.toggle('current', n === cur); li.classList.toggle('done', !!done[n] && n !== cur);
    if (n === cur) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
  });
  $$('[data-act]').forEach(b => {
    const act = b.dataset.act, reason = why(act);
    b.setAttribute('aria-disabled', reason ? 'true' : 'false'); b.title = reason || '';
    if (A[act].label) b.textContent = A[act].label(S);
    if (act === 'update') b.textContent = A.update.label(S);
  });
  $('#branchIn').disabled = S.hasBranch; if (S.hasBranch) $('#branchIn').value = S.branch;
  const mi = $('#msgIn'); if (!msgDirty) mi.value = suggestMsg();
  $$('input[name=ciopt]').forEach(x => { x.checked = (x.value === 'fail') === S.opts.fail; });
  $$('input[name=mgopt]').forEach(x => { x.checked = (x.value === 'squash') === S.opts.squash; x.disabled = S.merged; });
  $$('input[name=upopt]').forEach(x => { x.checked = x.value === S.opts.update; });
  $('#stepsNow').textContent = r ? 'いまここ：' + cur + '. ' + STEPS[cur - 1].t : (S.cloned ? '完了しました' : '');
}
function doneMap() {
  const d = {}, s = S;
  d[1] = s.cloned; d[2] = s.hasBranch; d[3] = !!s.did.edit; d[4] = !!s.did.add; d[5] = !!s.did.commit; d[6] = !!s.did.push; d[7] = !!s.mr;
  d[8] = !!s.did.ciPass; d[9] = s.review.state === 'resolved'; d[10] = s.merged; d[11] = !!s.did.branchD; d[12] = !!s.did.update;
  return d;
}
function renderControls() {
  const r = rec(S), nb = $('#nextBtn'), d = doneMap();
  let n = 0; [1, 2, 3, 4, 5, 6, 7, 8, 10, 11].forEach(i => { if (d[i]) n++; });
  $('#progFill').style.width = (n * 10) + '%'; $('#progText').textContent = n + ' / 10';
  nb.textContent = r ? 'つぎへ：' + A[r.act].short : (S.cloned ? '完了しました' : 'つぎへ');
  nb.setAttribute('aria-disabled', (!r || busy || playing) ? 'true' : 'false');
  const ab = $('#autoBtn'); ab.textContent = playing ? '停止' : 'おまかせ再生';
  ab.setAttribute('aria-disabled', (!playing && (!r || busy)) ? 'true' : 'false');
  $('#undoBtn').setAttribute('aria-disabled', (busy || !undoStack.length) ? 'true' : 'false');
  renderSteps();
}

/* ---------------- init ---------------- */
S = mkState();
buildSteps();
initGraph('remote', $('#gRemote')); initGraph('local', $('#gLocal'));
if (window.matchMedia && matchMedia('(max-width:760px)').matches) { $('#stepsDetails').open = false; $('#intro').open = false; }
renderAll(); renderExplain();
window.addEventListener('resize', () => { renderGraph('remote'); renderGraph('local'); });
window.__gitsim = { state: () => JSON.parse(JSON.stringify(S)) };
})();
