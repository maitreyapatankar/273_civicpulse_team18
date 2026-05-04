"""ticket assignment

Adds two columns to tickets:
- assigned_at: timestamp set when an officer dispatches a crew
- assigned_to: free-text crew identifier (officer can paste a name or crew code)

Revision ID: 0003
Revises: 0002
Create Date: 2026-05-03

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: Union[str, None] = "0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "tickets",
        sa.Column("assigned_at", sa.TIMESTAMP(timezone=True), nullable=True),
    )
    op.add_column(
        "tickets",
        sa.Column("assigned_to", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("tickets", "assigned_to")
    op.drop_column("tickets", "assigned_at")
