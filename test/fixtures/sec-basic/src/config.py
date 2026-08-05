"""Configuration loading — with two deliberate security defects."""

import subprocess


# A FAKE credential. Random characters that match AWS's access-key-id shape so
# gitleaks' default rules fire; it is not, and never was, a real key.
AWS_ACCESS_KEY_ID = "AKIAZ7QK4TGVN2XR6WPD"


def run_backup(target):
    """Runs a backup through the shell — the injection bandit and opengrep flag."""
    return subprocess.call("tar czf backup.tgz " + target, shell=True)
