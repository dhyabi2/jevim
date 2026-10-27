"""Jevim for Hermes: all-in-one browser automation, run locally from this repository."""

from pathlib import Path

from . import schemas, tools

_TOOLS = (
    ("jevim_canon", schemas.CANON, tools.canon_read),
    ("jevim_canon_confirm", schemas.CANON_CONFIRM, tools.canon_confirm),
    ("jevim_browse", schemas.BROWSE, tools.browse),
    ("jevim_index", schemas.INDEX, tools.index),
    ("jevim_ground", schemas.GROUND, tools.ground),
    ("jevim_form_fill", schemas.FORM_FILL, tools.form_fill),
    ("jevim_survey", schemas.SURVEY, tools.survey),
    ("jevim_script_author", schemas.SCRIPT_AUTHOR, tools.script_author),
    ("jevim_script_run", schemas.SCRIPT_RUN, tools.script_run),
    ("jevim_test_run", schemas.TEST_RUN, tools.test_run),
)


def register(ctx):
    for name, schema, handler in _TOOLS:
        ctx.register_tool(name=name, toolset="jevim", schema=schema, handler=handler,
                          check_fn=tools.node_available)
    skill = Path(__file__).parent / "skills" / "jevim-browser" / "SKILL.md"
    if skill.exists() and hasattr(ctx, "register_skill"):
        ctx.register_skill("jevim-browser", skill)
