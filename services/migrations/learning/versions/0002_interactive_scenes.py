"""interactive scenes: progress, evidence, request, queued status

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-20
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import Text  # noqa: F401
from sqlalchemy.dialects import postgresql

revision: str = "0002"
down_revision: Union[str, None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

JSON = sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), "postgresql")
OLD_STATUS = "status IN ('generating', 'ready', 'failed')"
NEW_STATUS = "status IN ('queued', 'generating', 'ready', 'failed')"


def upgrade() -> None:
    op.create_table(
        "scene_evidence",
        sa.Column("scene_id", sa.String(length=40), nullable=False),
        sa.Column("evidence_id", sa.String(length=64), nullable=False),
        sa.Column("evidence_revision", sa.Integer(), nullable=False),
        sa.Column("ord", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["scene_id"], ["scene_specs.id"], name=op.f("fk_scene_evidence_scene_id_scene_specs"),
                                ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("scene_id", "evidence_id", name=op.f("pk_scene_evidence")),
    )
    with op.batch_alter_table("scene_specs", schema=None) as b:
        # server defaults let existing rows take the new NOT NULL columns
        b.add_column(sa.Column("title", sa.String(length=120), nullable=False, server_default=""))
        b.add_column(sa.Column("request", sa.Text(), nullable=False, server_default=""))
        b.add_column(sa.Column("progress", JSON, nullable=False, server_default="{}"))
        b.add_column(sa.Column("error", sa.Text(), nullable=True))
        b.add_column(sa.Column("generator", sa.String(length=64), nullable=False, server_default=""))
        b.add_column(sa.Column("content_run_id", sa.BigInteger().with_variant(sa.Integer(), "sqlite"), nullable=True))
        b.add_column(sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                               server_default=sa.text("CURRENT_TIMESTAMP")))
        b.create_index("uq_scene_l1_per_run", ["chapter_id", "content_run_id"], unique=True,
                       postgresql_where=sa.text("level = 'l1'"), sqlite_where=sa.text("level = 'l1'"))
        b.create_foreign_key(b.f("fk_scene_specs_content_run_id_content_runs"), "content_runs", ["content_run_id"],
                             ["id"], ondelete="SET NULL")
        # enum = VARCHAR + CHECK, so a new status is just a new check constraint
        b.drop_constraint(op.f("ck_scene_specs_scene_status"), type_="check")
        b.create_check_constraint("scene_status", NEW_STATUS)


def downgrade() -> None:
    op.execute("UPDATE scene_specs SET status = 'generating' WHERE status = 'queued'")
    with op.batch_alter_table("scene_specs", schema=None) as b:
        b.drop_constraint(op.f("ck_scene_specs_scene_status"), type_="check")
        b.create_check_constraint("scene_status", OLD_STATUS)
        b.drop_constraint(b.f("fk_scene_specs_content_run_id_content_runs"), type_="foreignkey")
        b.drop_index("uq_scene_l1_per_run", postgresql_where=sa.text("level = 'l1'"),
                     sqlite_where=sa.text("level = 'l1'"))
        for col in ("updated_at", "content_run_id", "generator", "error", "progress", "request", "title"):
            b.drop_column(col)
    op.drop_table("scene_evidence")
