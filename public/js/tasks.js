// Shared browser helpers: JSON POST with CSRF, and live task output over SSE.
(function () {
  var csrfMeta = document.querySelector('meta[name="csrf-token"]');
  var csrf = csrfMeta ? csrfMeta.getAttribute('content') : '';

  function postJSON(url, body) {
    return fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify(body || {}),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        data._status = res.status;
        return data;
      });
    });
  }

  var STATUS_TEXT = {
    success: 'Finished successfully',
    failed: 'Failed',
    timed_out: 'Timed out',
    cancelled: 'Cancelled',
  };

  // Streams a task's output into `pre`. Calls onEnd({status, exitCode}).
  function stream(taskId, pre, opts) {
    opts = opts || {};
    pre.textContent = '';
    var es = new EventSource('/tasks/' + taskId + '/stream');
    var stick = true;
    pre.addEventListener('scroll', function () {
      stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
    });
    es.addEventListener('output', function (e) {
      pre.textContent += JSON.parse(e.data);
      if (stick) pre.scrollTop = pre.scrollHeight;
    });
    es.addEventListener('end', function (e) {
      es.close();
      var d = JSON.parse(e.data);
      if (opts.onEnd) opts.onEnd(d, STATUS_TEXT[d.status] || d.status);
    });
    es.onerror = function () {
      // The server closes the stream after 'end'; anything else is a lost connection.
      if (es.readyState === EventSource.CLOSED) return;
      es.close();
      if (opts.onEnd) opts.onEnd({ status: 'disconnected' }, 'Connection lost — reload to see the result');
    };
    return {
      cancel: function () { return postJSON('/tasks/' + taskId + '/cancel'); },
      close: function () { es.close(); },
    };
  }

  window.NocTasks = { postJSON: postJSON, stream: stream, csrf: csrf };
})();
