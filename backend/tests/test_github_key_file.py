from teamflow.config import Settings, safe_dump
from teamflow.github.client import build_client, credentials_present


def test_existing_key_file_can_be_used_without_copying_it_to_settings(tmp_path):
    path = tmp_path / "synthetic.pem"
    path.write_text("synthetic-key-material", encoding="utf-8")
    settings = Settings(_env_file=None, github_app_id="123", github_private_key_path=path)
    assert credentials_present(settings)
    client = build_client(settings, 456)
    assert client._private_key == "synthetic-key-material"
    assert settings.github_private_key is None
    assert "github_private_key_path" not in safe_dump(settings)
    path.unlink()
    assert not credentials_present(settings)
    assert build_client(settings, 456) is None


def test_settings_representation_omits_authentication_secrets():
    from teamflow.config import Settings

    settings = Settings(
        _env_file=None,
        audio_encryption_secret="synthetic-encryption",
        github_private_key="synthetic-private",
        github_webhook_secret="synthetic-hook",
        google_client_secret="synthetic-google",
        hf_token="synthetic-hf",
    )
    assert "synthetic-" not in repr(settings)
    assert settings.google_client_secret == "synthetic-google"
