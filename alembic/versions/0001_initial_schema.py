"""initial schema

Revision ID: 0001
Revises:
Create Date: 2026-04-24

"""
from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
from alembic import op

revision: str = "0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "raw_reports",
        sa.Column("id",             postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("source",         sa.Text(), nullable=False),
        sa.Column("text",           sa.Text()),
        sa.Column("image_url",      sa.Text()),
        sa.Column("lat",            sa.Float(), nullable=False),
        sa.Column("lng",            sa.Float(), nullable=False),
        sa.Column("address",        sa.Text()),
        sa.Column("reporter_phone", sa.Text()),
        sa.Column("submitted_at",   sa.TIMESTAMP(timezone=True),
                  server_default=sa.text("NOW()")),
        sa.Column("status",         sa.Text(), server_default="queued"),
    )
    op.create_index("idx_raw_reports_status", "raw_reports", ["status"])

    op.create_table(
        "tickets",
        sa.Column("id",                  postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("raw_report_id",       postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("raw_reports.id")),
        sa.Column("issue_type",          sa.Text()),
        sa.Column("severity",            sa.Integer()),
        sa.Column("urgency_score",       sa.Float()),
        sa.Column("urgency_factors",     postgresql.JSONB()),
        sa.Column("ai_reasoning",        sa.Text()),
        sa.Column("confidence",          sa.Float()),
        sa.Column("duplicate_of",        postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("tickets.id")),
        sa.Column("cluster_count",       sa.Integer(), server_default="1"),
        sa.Column("work_order",          postgresql.JSONB()),
        sa.Column("dispatcher_override", sa.Boolean(), server_default="false"),
        sa.Column("override_by",         sa.Text()),
        sa.Column("override_at",         sa.TIMESTAMP(timezone=True)),
        sa.Column("resolved_at",         sa.TIMESTAMP(timezone=True)),
        sa.Column("created_at",          sa.TIMESTAMP(timezone=True),
                  server_default=sa.text("NOW()")),
    )
    op.create_index("idx_tickets_urgency", "tickets", [sa.text("urgency_score DESC")])
    op.create_index("idx_tickets_created", "tickets", [sa.text("created_at DESC")])


def downgrade() -> None:
    op.drop_index("idx_tickets_created",    table_name="tickets")
    op.drop_index("idx_tickets_urgency",    table_name="tickets")
    op.drop_table("tickets")

    op.drop_index("idx_raw_reports_status", table_name="raw_reports")
    op.drop_table("raw_reports")
