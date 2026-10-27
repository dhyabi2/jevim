"""Record a browser-use run, or replay one with browser-use's own rerun, for the replay comparison.

    python bench/h2h/bu_replay.py record TASK.json OUT_DIR
    python bench/h2h/bu_replay.py replay OUT_DIR TAG

`record` runs the agent like bu_run.py and also saves its history (history.json) and final URL.
`replay` loads that history into a fresh browser and calls Agent.load_and_rerun with skip_failures,
browser-use's documented way to re-execute a run. Every LLM call made during the rerun is counted by
wrapping the model, so the replay's cost is measured, not assumed. Writes OUT_DIR/replay-TAG.json.
"""
import asyncio
import json
import os
import sys
import time

os.environ.setdefault('ANONYMIZED_TELEMETRY', 'false')
os.environ.setdefault('BROWSER_USE_CLOUD_SYNC', 'false')

from browser_use import Agent, BrowserProfile, BrowserSession  # noqa: E402
from browser_use.llm.openai.chat import ChatOpenAI  # noqa: E402

MODEL = os.environ.get('H2H_MODEL', 'deepseek/deepseek-v4.1-flash')


def counted_llm():
    llm = ChatOpenAI(model=MODEL, base_url='https://nano-gpt.com/api/v1', api_key=os.environ['NANO_API_KEY'], timeout=120)
    stats = {'calls': 0, 'prompt_tokens': 0, 'completion_tokens': 0}
    original = llm.ainvoke

    async def ainvoke(*args, **kwargs):
        stats['calls'] += 1
        out = await original(*args, **kwargs)
        usage = getattr(out, 'usage', None)
        if usage:
            stats['prompt_tokens'] += getattr(usage, 'prompt_tokens', 0) or 0
            stats['completion_tokens'] += getattr(usage, 'completion_tokens', 0) or 0
        return out

    object.__setattr__(llm, 'ainvoke', ainvoke)
    return llm, stats


async def record(task_path, out_dir):
    task = json.load(open(task_path))
    os.makedirs(out_dir, exist_ok=True)
    json.dump(task, open(os.path.join(out_dir, 'task.json'), 'w'))
    llm, stats = counted_llm()
    session = BrowserSession(browser_profile=BrowserProfile(headless=True, keep_alive=True))
    agent = Agent(task=task['confirmed_task'], llm=llm, browser_session=session,
                  initial_actions=[{'navigate': {'url': task['website'], 'new_tab': False}}], calculate_cost=False)
    started = time.time()
    out = {'agent': 'browser-use', 'task_id': task['task_id'], 'website': task['website']}
    try:
        history = await asyncio.wait_for(agent.run(max_steps=25), timeout=900)
        agent.save_history(os.path.join(out_dir, 'history.json'))
        out.update(final=history.final_result() or '', steps=history.number_of_steps(),
                   actions=len(history.model_actions()), final_url=await session.get_current_page_url())
    except Exception as exc:
        out.update(final='', error=f'{type(exc).__name__}: {exc}'[:300])
    out.update(seconds=round(time.time() - started, 1), llm=stats)
    try:
        await session.kill()
    except Exception:
        pass
    json.dump(out, open(os.path.join(out_dir, 'record.json'), 'w'), indent=1)


async def replay(out_dir, tag):
    task = json.load(open(os.path.join(out_dir, 'task.json')))
    llm, stats = counted_llm()
    session = BrowserSession(browser_profile=BrowserProfile(headless=True, keep_alive=True))
    agent = Agent(task=task['confirmed_task'], llm=llm, browser_session=session, calculate_cost=False)
    started = time.time()
    out = {'agent': 'browser-use', 'tag': tag}
    try:
        results = await asyncio.wait_for(
            agent.load_and_rerun(os.path.join(out_dir, 'history.json'), skip_failures=True, max_retries=1,
                                 delay_between_actions=1.0, max_step_interval=5.0),
            timeout=900)
        errored = [r for r in results if getattr(r, 'error', None)]
        out.update(results=len(results), errored=len(errored),
                   errors=[str(r.error)[:160] for r in errored][:10],
                   final_url=await session.get_current_page_url())
    except Exception as exc:
        out.update(error=f'{type(exc).__name__}: {exc}'[:300])
    out.update(seconds=round(time.time() - started, 1), llm=stats)
    try:
        await session.kill()
    except Exception:
        pass
    json.dump(out, open(os.path.join(out_dir, f'replay-{tag}.json'), 'w'), indent=1)


if __name__ == '__main__':
    mode = sys.argv[1]
    if mode == 'record':
        asyncio.run(record(sys.argv[2], sys.argv[3]))
    else:
        asyncio.run(replay(sys.argv[2], sys.argv[3]))
