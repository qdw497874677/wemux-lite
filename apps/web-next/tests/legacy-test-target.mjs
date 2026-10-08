const nonempty = value => typeof value === 'string' && value.trim().length > 0
const taskPrefix = projectId => `/api/projects/${encodeURIComponent(projectId)}/tasks`

function bindingItems(response) {
  // These public routes currently return complete, unpaginated { items } views.
  // A changed/partial envelope is not evidence of absence.
  if (!response || Object.keys(response).length !== 1 || !Array.isArray(response.items)) throw Error('binding preflight unavailable')
  return response.items
}

async function observedBoundWorkspaces(projectId, request) {
  const prefix = taskPrefix(projectId)
  const tasks = bindingItems(await request(prefix))
  const taskIds = new Set(), bound = new Set()
  for (const task of tasks) {
    if (!task || !nonempty(task.id) || task.projectId !== projectId || taskIds.has(task.id)) throw Error('binding preflight unavailable')
    taskIds.add(task.id)
    // Task summaries/assignees do not describe all bindings, including done Tasks.
    const bindings = bindingItems(await request(`${prefix}/${encodeURIComponent(task.id)}/workspaces`))
    for (const binding of bindings) {
      if (!binding || binding.taskId !== task.id || binding.projectId !== projectId || !nonempty(binding.workspaceId) || !nonempty(binding.createdAt) || bound.has(binding.workspaceId)) throw Error('binding preflight unavailable')
      bound.add(binding.workspaceId)
    }
  }
  return bound
}

// Query only authorized public views; never infer placement readiness from legacy fields.
// Enumeration is best effort, not an atomic unbound assertion or write authorization.
export async function findSafeTestAgentTarget({ projects, workers, request }) {
  const safeTargets = []
  for (const project of projects) {
    const workspaces = bindingItems(await request(`/api/workspaces?projectId=${encodeURIComponent(project.id)}`))
    const bound = await observedBoundWorkspaces(project.id, request)
    for (const workspace of workspaces) {
      if (workspace.projectId !== project.id || workspace.deletedAt || bound.has(workspace.id)) continue
      const placements = Array.isArray(workspace.placements) ? workspace.placements : []
      safeTargets.push({ placementStates: placements.map(placement => placement.status) })
      for (const placement of placements) {
        if (placement.status !== 'ready') continue
        const worker = workers.find(value => value.id === placement.workerId && value.connectionState === 'online')
        if (!worker) continue
        const capabilities = (await request(`/api/workers/${encodeURIComponent(worker.id)}/capabilities`)).capabilities
        const agent = capabilities.find(value => value.agentKey === 'test' && value.mode === 'execution' && value.availability?.status === 'available' && Array.isArray(value.models) && value.models.some(model => typeof model.modelId === 'string' && model.modelId.length > 0))
        if (agent) {
          const model = agent.models.find(value => typeof value.modelId === 'string' && value.modelId.length > 0)
          return { selection: { project, workspace, worker, agent, model }, safeTargets }
        }
      }
    }
  }
  return { selection: undefined, safeTargets }
}

// Called only by the explicitly opted-in write branch. Do not retry another target:
// create and bind are separate writes, and a lost response can leave unknown effects.
export async function createRetainedTestTask({ selection, request, retain }) {
  const { project, workspace, worker } = selection
  const prefix = taskPrefix(project.id)
  const created = await request(prefix, 'POST', { title: 'Ticket01 验收 Test Agent 安全接线', description: '仅验证旧UI创建/发送/持久化。Test Agent，无模型费用，不启动Run，不自动完成或删除。' })
  if (!nonempty(created?.id) || created.projectId !== project.id) throw Error('Task creation response unconfirmed; manual inspection required')
  const taskPath = `${prefix}/${encodeURIComponent(created.id)}`
  const retained = {
    projectId: project.id, taskId: created.id, workspaceId: workspace.id, workerId: worker.id,
    bindingOutcome: 'binding-pending',
    recovery: {
      taskPath, bindingsPath: `${taskPath}/workspaces`,
      workspacePath: `/api/workspaces/${encodeURIComponent(workspace.id)}`,
      instructions: 'Task creation is retained. Binding may be unknown if a response or evidence write failed. With manual authorization, GET taskPath and bindingsPath using the same authorized public API; inspect all project Task bindings before choosing any recovery. Do not automatically retry, create another Task, unbind another Task, delete, or cancel anything. Reuse this exact Task only after confirming current ownership and permissions; if abandoned, an authorized operator must explicitly decide its disposition through normal UI/API (no Task delete route). No assignment, Session or Run is attempted by this helper after a binding failure.',
    },
  }
  // Durable exact IDs and recovery instructions must precede the binding write.
  await retain(retained, created)
  let task
  try {
    task = await request(`${taskPath}/workspaces/${encodeURIComponent(workspace.id)}`, 'PUT', {})
  } catch (error) {
    retained.bindingOutcome = error?.status === 409 && error?.code === 'workspace_bound' ? 'workspace_bound' : 'binding-unconfirmed'
    await retain(retained, created)
    throw Error('binding not confirmed; retained Task requires manually authorized recovery')
  }
  retained.bindingOutcome = 'bound'
  await retain(retained, task)
  return { task, retained }
}

// Retain only the one known conflict code, never arbitrary server error text/body.
export async function readLegacyPublicResponse(response) {
  if (!response.ok()) {
    let body
    try { body = await response.json() } catch {}
    const error = Error('public request rejected')
    error.status = response.status()
    if (error.status === 409 && body?.error?.code === 'workspace_bound') error.code = 'workspace_bound'
    throw error
  }
  return response.status() === 204 ? null : response.json()
}
