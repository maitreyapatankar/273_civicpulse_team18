import os
from contextlib import contextmanager

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, DeclarativeBase

DATABASE_URL = os.environ["DATABASE_URL"]

engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,   # validate connection before checkout (#21)
    pool_size=5,          # persistent connections kept open
    max_overflow=10,      # allow up to 15 total under burst
    pool_timeout=30,      # raise after 30 s waiting for a free slot (#22)
    pool_recycle=1800,    # recycle connections older than 30 min — prevents stale
                          # connections from cloud DBs that silently timeout idle sockets (#21)
)
SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)


class Base(DeclarativeBase):
    pass


@contextmanager
def get_db():
    db = SessionLocal()
    try:
        yield db
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
