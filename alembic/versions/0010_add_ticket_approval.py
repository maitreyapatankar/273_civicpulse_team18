"""add approved column to tickets

Revision ID: 0010
Revises: 0009
Create Date: 2026-05-05
"""
from alembic import op
import sqlalchemy as sa

revision = '0010'
down_revision = '0009'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('tickets', sa.Column('approved', sa.Boolean(), nullable=False, server_default='false'))


def downgrade():
    op.drop_column('tickets', 'approved')
