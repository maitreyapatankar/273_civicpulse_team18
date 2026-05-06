"""add schedules table

Revision ID: 0008
Revises: 0007
Create Date: 2026-05-05

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "0008"
down_revision: Union[str, None] = "0007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "schedules",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("zone_lat", sa.Float(), nullable=False),
        sa.Column("zone_lng", sa.Float(), nullable=False),
        sa.Column("crew_type", sa.Text(), nullable=False),
        sa.Column("ticket_ids", JSONB(), nullable=False),
        sa.Column("est_hours", sa.Float(), nullable=True),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=True),
    )
    op.create_index("idx_schedules_date", "schedules", [sa.text("date DESC")])


def downgrade() -> None:
    op.drop_index("idx_schedules_date", table_name="schedules")
    op.drop_table("schedules")
