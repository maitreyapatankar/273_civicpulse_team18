"""add classify fields to tickets

Revision ID: 0005
Revises: 0003
Create Date: 2026-05-04

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0005"
down_revision: Union[str, None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("tickets", sa.Column("category_code", sa.Text(), nullable=True))
    op.add_column("tickets", sa.Column("category_name", sa.Text(), nullable=True))
    op.add_column("tickets", sa.Column("subcategory_code", sa.Text(), nullable=True))
    op.add_column("tickets", sa.Column("subcategory_name", sa.Text(), nullable=True))
    op.add_column(
        "tickets",
        sa.Column(
            "image_text_conflict",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
    )
    op.add_column(
        "tickets",
        sa.Column(
            "needs_review",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("tickets", "needs_review")
    op.drop_column("tickets", "image_text_conflict")
    op.drop_column("tickets", "subcategory_name")
    op.drop_column("tickets", "subcategory_code")
    op.drop_column("tickets", "category_name")
    op.drop_column("tickets", "category_code")
