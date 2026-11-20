const $ = (id) => document.getElementById(id);
const magpie = globalThis.magpie;
const form = document.querySelector('form');
const fields = document.querySelector('fieldset');
let zh = false;
const say = (en, cn) => (zh ? cn : en);

function addTime(value = '') {
  const row = document.createElement('div');
  row.className = 'time';
  const input = document.createElement('input');
  input.type = 'time';
  input.required = true;
  input.value = value;
  input.setAttribute('aria-label', $('times-label').textContent);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = '×';
  remove.setAttribute('aria-label', say('Remove time', '移除时间'));
  remove.onclick = () => {
    row.remove();
    $('add').focus();
  };
  row.append(input, remove);
  $('times').append(row);
  return input;
}

async function init() {
  try {
    const theme = await magpie.ready;
    zh = theme.lang?.startsWith('zh');
    document.documentElement.style.colorScheme = theme.dark ? 'dark' : 'light';
    if (zh) {
      document.documentElement.lang = 'zh';
      for (const [id, text] of Object.entries({
        title: 'Remote CC 预热',
        'reset-label': '窗口重置时预热',
        'daily-label': '每日定时预热',
        'times-label': '每日开始时间',
        'gap-label': '错峰间隔',
        unit: '分钟',
        hint: '间隔 120 分钟时，06:00 起依次排为 06:00、08:00、10:00。填 0 不错峰。以运行 Magpie 的机器时间为准。',
        add: '+ 添加时间',
        save: '保存设置',
      }))
        $(id).textContent = text;
      ['关闭', '每周', '每周和 5 小时'].forEach((label, i) => {
        $('mode').options[i].text = label;
      });
    }
    magpie.onAction((action) => {
      if (action.id === 'remote-cc-warmup') $('mode').focus();
    });
    const options = await magpie.options.get();
    $('mode').value = options.warmMode ?? '';
    if (!$('mode').value) {
      $('mode').add(new Option(say('Keep existing setting', '沿用原设置'), ''));
      $('mode').value = '';
    }
    $('daily').checked = options.warmDaily === true;
    $('daily').indeterminate = typeof options.warmDaily !== 'boolean';
    $('gap').value = options.warmGap ?? 120;
    const times = options.warmAts ?? ['06:00'];
    for (const value of Array.isArray(times) ? times : [times]) {
      const at = String(value)
        .trim()
        .match(/^(\d{1,2}):([0-5]\d)(?::[0-5]\d)?$/);
      if (at && Number(at[1]) < 24) addTime(`${at[1].padStart(2, '0')}:${at[2]}`);
    }
    fields.disabled = false;
  } catch {
    $('status').textContent = say(
      'Could not read settings. Reopen this page to retry.',
      '无法读取设置，请重新打开页面。',
    );
  }
}

$('add').onclick = () => addTime().focus();
// Magpie's plugin iframe allows scripts, not form submissions.
$('save').onclick = async () => {
  if (fields.disabled || !form.reportValidity()) return;
  const warmAts = [
    ...new Set(Array.from($('times').querySelectorAll('input'), (i) => i.value)),
  ].sort();
  const warmGap = $('gap').valueAsNumber;
  const warmMode = $('mode').value;
  const daily = $('daily');
  if (daily.checked && !warmAts.length) {
    $('status').textContent = say(
      'Add at least one daily start time.',
      '请至少添加一个每日开始时间。',
    );
    return;
  }
  fields.disabled = true;
  try {
    const options = await magpie.options.get();
    await magpie.options.set({
      ...options,
      warmAts,
      warmGap,
      ...(warmMode ? { warmMode } : {}),
      ...(!daily.indeterminate ? { warmDaily: daily.checked } : {}),
    });
    $('status').textContent = say('Settings saved.', '已保存设置。');
  } catch {
    $('status').textContent = say('Could not save. Try again.', '保存失败，请重试。');
  } finally {
    fields.disabled = false;
  }
};

void init();
