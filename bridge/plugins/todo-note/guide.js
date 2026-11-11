export const GUIDE = `## Todo note (todo_note)

This session has a draggable sticky note the user watches: short-term tasks ("what now / what next / what is parked") plus a long-term plan with phase progress. It is the shared source of truth between you and the user, and it saves you from re-reading the conversation.

- Before work, \`todo_note_read\` — cheap, and it tells you where the session actually stands.
- At the start of each substantive turn, check the note; before your final response, review relevant tasks and submit only actually finished work for user confirmation.
- While working on a listed task, set focus.current to that task's exact title. The web panel highlights that task while the turn runs. Update it when the active task changes; never guess progress or mark unverified work complete.
- If the user parks the main work for a branch, shelve its relevant tasks and change the main phase to paused and the branch phase to active, preserving every phase. Resume the parked work only when requested. If this session's older tool schema does not accept paused, keep that phase as todo and make the parked state explicit in focus instead.
- As you go, \`todo_note_update\` (focus, add/update/shelve/remove tasks, set_plan). Several small updates beat one big one.
- When a piece of work is finished, \`todo_note_complete\`: it moves the task to "awaiting", and the user ticks it off in the panel. Do not tell the user something is done while it still awaits their confirmation.
- \`set_plan\` replaces the whole plan, so send the complete goal/phase list with honest statuses. Keep phase titles stable — the user sees them as a timeline.
- Keep the note short and current: the user reads it at a glance, and every line costs prompt tokens.
- The list order is the priority order: keep the task the user should do first at the top, and use move_task (or the drag handle in the note) to promote one.
- One task = one concrete action. When a step has several parts, add them as separate tasks (a real checklist); never pack a list of items into one task title.
- Park work with state "shelved" and set \`phase\` to the plan phase it belongs to, so the panel can hang it off that phase as a branch.
- A brand new session is **not linked** yet: the first turn carries a one-line reminder. Link it once (write the focus and 1–3 real tasks with \`todo_note_update\`), and never re-link or repeat the reminder. A linked session stays linked; the panel shows a small “未关联” chip until then. If the user clicks that chip, they are asking you to link now — treat the next turn as that request.
- When the user rejects a task, it returns to active with \`rejects\` > 0 and a "用户未通过" line in the snapshot: that is feedback, so reflect on it and change the approach before calling \`todo_note_complete\` again.
- Treat unaccepted tasks as an open quality loop. Read user feedback before choosing the next action. For rejected work, reproduce the problem, make a concrete improvement, and provide a new verification note when resubmitting; repeating the previous completion claim is not progress.
- Awaiting tasks still need user acceptance. While the user is away, independently review the implementation and fix verifiable defects, but never confirm on the user's behalf or repeatedly resubmit unchanged work. Keep meaningful remaining issues active and describe tested work as submitted for review.
`
