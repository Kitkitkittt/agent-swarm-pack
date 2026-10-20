(() => {
  const statusDot = document.getElementById('status-dot')
  const statusText = document.getElementById('status-text')
  const refreshButton = document.getElementById('refresh-btn')
  const lastRefresh = document.getElementById('last-refresh')

  function setStatus(kind, text) {
    statusDot.className = `dot ${kind}`
    statusText.textContent = text
  }

  function setValue(id, value) {
    document.getElementById(id).textContent = String(value)
  }

  function formatTime(value) {
    if (!value) return '-'
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString()
  }

  function cell(row, value, { tag, className } = {}) {
    const td = document.createElement('td')
    const node = tag ? document.createElement(tag) : td
    if (className) node.className = className
    node.textContent = String(value)
    if (tag) td.append(node)
    row.append(td)
  }

  function pill(row, value) {
    cell(row, value || 'unknown', { tag: 'span', className: 'pill' })
  }

  function renderRows(id, values, columns, emptyText, render) {
    const table = document.getElementById(id)
    const rows = Array.isArray(values) ? values : []
    const fragment = document.createDocumentFragment()
    if (!rows.length) {
      const row = document.createElement('tr')
      cell(row, emptyText, { className: 'muted' })
      row.firstElementChild.colSpan = columns
      fragment.append(row)
    } else {
      for (const value of rows) {
        const row = document.createElement('tr')
        render(row, value || {})
        fragment.append(row)
      }
    }
    table.replaceChildren(fragment)
  }

  function renderTasks(tasks) {
    renderRows('tasks-table', tasks, 6, 'No tasks yet.', (row, task) => {
      cell(row, task.id || '', { tag: 'code' })
      cell(row, task.title || task.description || '(untitled)')
      pill(row, task.status)
      pill(row, task.priority)
      pill(row, task.approvalStatus || 'none')
      cell(row, formatTime(task.updatedAt || task.createdAt), { className: 'muted' })
    })
  }

  function renderApprovals(approvals) {
    renderRows('approvals-table', approvals, 5, 'No approvals yet.', (row, approval) => {
      cell(row, approval.id || '', { tag: 'code' })
      cell(row, approval.taskTitle || approval.taskId || '-')
      pill(row, approval.status)
      pill(row, approval.priority)
      cell(row, formatTime(approval.updatedAt || approval.createdAt), { className: 'muted' })
    })
  }

  let refreshPending = false

  async function refresh() {
    if (refreshPending) return
    refreshPending = true
    setStatus('warn', 'Refreshing...')
    refreshButton.disabled = true
    try {
      const response = await fetch('/dashboard/data', { cache: 'no-store' })
      if (!response.ok) throw new Error(`http_${response.status}`)
      const payload = await response.json()
      const summary = payload.summary || {}
      const routes = summary.routes || {}
      const tasks = summary.standaloneTasks || {}
      const approvals = summary.approvals || {}
      const routeTotal = Number(routes.channels || 0) + Number(routes.projects || 0) + Number(routes.tasks || 0)
      setValue('tasks-total', tasks.total || 0)
      setValue('tasks-hint', `pending approval: ${Number(tasks.approvalsPending || 0)}`)
      setValue('approvals-total', approvals.pending || 0)
      setValue('approvals-hint', `approved: ${Number(approvals.approved || 0)} | rejected: ${Number(approvals.rejected || 0)}`)
      setValue('runs-total', tasks.activeRuns || 0)
      setValue('runs-hint', tasks.runnerConfigured ? 'runner configured' : 'runner not configured')
      setValue('routes-total', routeTotal)
      setValue('routes-hint', `ch:${Number(routes.channels || 0)} | pr:${Number(routes.projects || 0)} | tk:${Number(routes.tasks || 0)}`)
      renderTasks(payload.tasks)
      renderApprovals(payload.approvals)
      setStatus('live', 'Live')
      lastRefresh.textContent = new Date().toLocaleString()
    } catch (error) {
      setStatus('error', 'Refresh failed')
      lastRefresh.textContent = String(error?.message || error)
    } finally {
      refreshPending = false
      refreshButton.disabled = false
    }
  }

  refreshButton.addEventListener('click', () => { void refresh() })
  void refresh()
  setInterval(() => { void refresh() }, 5000)
})()
