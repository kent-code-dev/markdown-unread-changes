// Markdown Unread Changes：変更前のテキストを、ホバーでツールチップ表示、クリックでその場に展開する。
// プレビューの中だけで動き、通信は一切しない。
(function () {
  'use strict';

  var TITLE = '変更前';
  var tooltip = null;

  function oldTextHost(target) {
    return target && target.closest ? target.closest('[data-muc-old]') : null;
  }

  function showTooltip(host, x, y) {
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.className = 'muc-tooltip';
      document.body.appendChild(tooltip);
    }
    tooltip.textContent = '';
    var title = document.createElement('div');
    title.className = 'muc-tooltip-title';
    title.textContent = TITLE + '（クリックで展開）';
    var body = document.createElement('div');
    body.textContent = host.getAttribute('data-muc-old');
    tooltip.appendChild(title);
    tooltip.appendChild(body);
    tooltip.style.display = 'block';
    moveTooltip(x, y);
  }

  function moveTooltip(x, y) {
    if (!tooltip) {
      return;
    }
    var left = Math.min(x + 12, window.innerWidth - tooltip.offsetWidth - 8);
    var top = y + 16;
    if (top + tooltip.offsetHeight > window.innerHeight - 8) {
      top = Math.max(8, y - tooltip.offsetHeight - 8);
    }
    tooltip.style.left = Math.max(8, left) + 'px';
    tooltip.style.top = top + 'px';
  }

  function hideTooltip() {
    if (tooltip) {
      tooltip.style.display = 'none';
    }
  }

  // 展開表示の切り替え。表の行は、直後に行を差し込む
  function toggleInline(host) {
    var next = host.nextElementSibling;
    if (next && next.classList.contains('muc-old-inline-host')) {
      next.remove();
      return;
    }
    var box = document.createElement('div');
    box.className = 'muc-old-inline';
    var title = document.createElement('div');
    title.className = 'muc-old-inline-title';
    title.textContent = TITLE;
    var body = document.createElement('div');
    body.textContent = host.getAttribute('data-muc-old');
    box.appendChild(title);
    box.appendChild(body);

    var wrapper;
    if (host.tagName === 'TR') {
      wrapper = document.createElement('tr');
      var cell = document.createElement('td');
      cell.colSpan = host.children.length || 1;
      cell.appendChild(box);
      wrapper.appendChild(cell);
    } else {
      wrapper = box;
    }
    wrapper.classList.add('muc-old-inline-host');
    host.parentNode.insertBefore(wrapper, host.nextSibling);
  }

  document.addEventListener('mouseover', function (e) {
    var host = oldTextHost(e.target);
    if (host) {
      showTooltip(host, e.clientX, e.clientY);
    } else {
      hideTooltip();
    }
  });

  document.addEventListener('mousemove', function (e) {
    if (tooltip && tooltip.style.display === 'block') {
      moveTooltip(e.clientX, e.clientY);
    }
  });

  document.addEventListener('mouseleave', hideTooltip);
  window.addEventListener('scroll', hideTooltip, true);

  document.addEventListener('click', function (e) {
    var target = e.target;
    // リンクやチェックボックスのクリック、文字の選択は邪魔しない
    if (!target || !target.closest || target.closest('a, input, button, summary')) {
      return;
    }
    var selection = window.getSelection && window.getSelection();
    if (selection && String(selection).length > 0) {
      return;
    }
    var host = oldTextHost(target);
    if (host) {
      hideTooltip();
      toggleInline(host);
    }
  });
})();
