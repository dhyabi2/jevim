"""Run one Online-Mind2Web task with the open-source browser-use agent, for the head-to-head.

    ~/work/bu-baseline/.venv/bin/python bench/h2h/bu_run.py TASK.json OUT_DIR

The task JSON is one row of Online_Mind2Web.json. The model is the same one our agent uses, through the
same OpenAI-compatible endpoint, so the comparison is between the two agents and not between two models.
Output is result.json plus final.png in OUT_DIR, in the shape bench/h2h/judge.mjs reads for both agents.
"""
import asyncio
import base64
import json
import os
import sys
import time

# Nothing about a benchmark run should leave this machine except the model calls themselves.
os.environ.setdefault('ANONYMIZED_TELEMETRY', 'false')
os.environ.setdefault('BROWSER_USE_CLOUD_SYNC', 'false')

from browser_use import Agent, BrowserProfile, BrowserSession  # noqa: E402
from browser_use.llm.openai.chat import ChatOpenAI  # noqa: E402

MODEL = os.environ.get('H2H_MODEL', 'deepseek/deepseek-v4.1-flash')
MAX_STEPS = int(os.environ.get('H2H_MAX_STEPS', '25'))


async def main(task_path, out_dir):
    task = json.load(open(task_path))
    os.makedirs(out_dir, exist_ok=True)
    llm = ChatOpenAI(model=MODEL, base_url='https://nano-gpt.com/api/v1', api_key=os.environ['NANO_API_KEY'],
                     timeout=120)
    session = BrowserSession(browser_profile=BrowserProfile(headless=True, keep_alive=False))
    agent = Agent(task=task['confirmed_task'], llm=llm, browser_session=session,
                  initial_actions=[{'navigate': {'url': task['website'], 'new_tab': False}}],
                  calculate_cost=False)
    started = time.time()
    result = {'agent': 'browser-use', 'version': _version(), 'model': MODEL, 'task_id': task['task_id'],
              'task': task['confirmed_task'], 'website': task['website'], 'level': task.get('level')}
    try:
        history = await asyncio.wait_for(agent.run(max_steps=MAX_STEPS), timeout=float(os.environ.get('H2H_TIMEOUT', '900')))
        result.update(
            final=history.final_result() or '',
            done=history.is_done(),
            steps=history.number_of_steps(),
            trace=_trace(history),
            errors=[e for e in history.errors() if e],
            tokens={'prompt': history.usage.total_prompt_tokens if history.usage else None,
                    'completion': history.usage.total_completion_tokens if history.usage else None},
        )
        shots = [p for p in history.screenshot_paths() if p]
        if shots:
            with open(shots[-1], 'rb') as f:
                open(os.path.join(out_dir, 'final.png'), 'wb').write(f.read())
    except Exception as exc:  # a crash is a failed task, recorded, not a crashed batch
        result.update(final='', done=False, error=f'{type(exc).__name__}: {exc}'[:500])
    finally:
        result['seconds'] = round(time.time() - started, 1)
        try:
            await session.kill()
        except Exception:
            pass
    json.dump(result, open(os.path.join(out_dir, 'result.json'), 'w'), indent=1)


def _trace(history):
    """One readable line per action, naming the element by its accessible name as our trace does.

    The judge sees both agents' traces; a trace of bare element indices next to one of named elements
    would tilt the strict rubric toward whichever agent names its targets.
    """
    lines = []
    for h in history.history:
        if not h.model_output:
            continue
        url = getattr(h.state, 'url', '') or ''
        elements = h.state.interacted_element or [None] * len(h.model_output.action)
        for action, element, res in zip(h.model_output.action, elements, h.result or []):
            data = action.model_dump(exclude_none=True, mode='json')
            verb, params = next(iter(data.items())) if data else ('?', {})
            params = {k: v for k, v in (params or {}).items() if k != 'index'} if isinstance(params, dict) else params
            target = ''
            if element is not None:
                name = (element.ax_name or (element.attributes or {}).get('aria-label') or '')[:60]
                target = f' {element.node_name.lower()} "{name}"'
            outcome = 'error: ' + str(res.error)[:120] if res.error else ('ok' if not res.extracted_content else str(res.extracted_content)[:160])
            lines.append({'url': url, 'action': f'{verb}{target} {json.dumps(params)[:200] if params else ""}'.strip(), 'outcome': outcome})
    return lines


def _version():
    import importlib.metadata as m
    return m.version('browser-use')


if __name__ == '__main__':
    asyncio.run(main(sys.argv[1], sys.argv[2]))
