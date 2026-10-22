"""decisions: new action "lab" (invite the learner to try the chapter's lab)

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-22
"""
from typing import Sequence, Union

from alembic import op

revision: str = "0003"
down_revision: Union[str, None] = "0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

OLD = "('none', 'check_in', 'quiz', 'predict', 'rewatch', 'explain', 'link')"
NEW = "('none', 'check_in', 'quiz', 'predict', 'rewatch', 'explain', 'link', 'lab')"


def _swap(values: str) -> None:
    # enum = VARCHAR + CHECK, so a new action is just a new pair of check constraints
    with op.batch_alter_table("decisions", schema=None) as b:
        for col in ("rule_action", "action"):
            b.drop_constraint(op.f(f"ck_decisions_{col}"), type_="check")
            b.create_check_constraint(col, f"{col} IN {values}")


def upgrade() -> None:
    _swap(NEW)


def downgrade() -> None:
    op.execute("UPDATE decisions SET action = 'none' WHERE action = 'lab'")
    op.execute("UPDATE decisions SET rule_action = 'none' WHERE rule_action = 'lab'")
    _swap(OLD)
