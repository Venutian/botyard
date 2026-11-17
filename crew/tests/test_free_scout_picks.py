"""Which listed models the free scout counts as free and worth its coding test. A signed-in free provider
whose big coding models are never tested is free capacity the crew never gets."""
import importlib.util
import os
import sys
import unittest

CREW = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
sys.path.insert(0, CREW)
spec = importlib.util.spec_from_file_location('free_scout_picks', os.path.join(CREW, 'free-scout.py'))
scout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scout)


class Picks(unittest.TestCase):
    def test_groq_big_coding_models_are_tested(self):
        self.assertTrue(scout.is_free('groq/openai/gpt-oss-120b'))
        self.assertTrue(scout.is_free('groq/qwen/qwen3.8-27b'))

    def test_groq_small_and_speech_models_are_not(self):
        for model in ('groq/openai/gpt-oss-20b', 'groq/whisper-large-v3', 'groq/canopylabs/orpheus-v1-english',
                      'groq/meta-llama/llama-prompt-guard-2-86m', 'groq/allam-2-7b'):
            self.assertFalse(scout.is_free(model), model)

    def test_cloudflare_newer_coding_models_are_tested(self):
        for model in ('cloudflare-workers-ai/@cf/zai-org/glm-5.3', 'cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4.1-flash-1017',
                      'cloudflare-workers-ai/@cf/qwen/qwen3.8-27b', 'cloudflare-workers-ai/@cf/zai-org/glm-4.7-flash',
                      'cloudflare-workers-ai/@cf/openai/gpt-oss-120b'):
            self.assertTrue(scout.is_free(model), model)

    def test_cloudflare_small_models_are_not(self):
        for model in ('cloudflare-workers-ai/@cf/openai/gpt-oss-20b', 'cloudflare-workers-ai/@cf/meta/llama-guard-3-8b',
                      'cloudflare-workers-ai/@cf/ibm-granite/granite-4.0-h-micro'):
            self.assertFalse(scout.is_free(model), model)

    def test_kilo_only_its_free_models(self):
        self.assertTrue(scout.is_free('kilo/nvidia/nemotron-3-ultra-550b-a55b:free'))
        self.assertFalse(scout.is_free('kilo/anthropic/claude-sonnet-5-5'))   # sold on the same key
        self.assertFalse(scout.is_free('kilo/z-ai/glm-5.3'))
        self.assertFalse(scout.is_free('kilo/liquid/lfm-3-1.7b:free'))        # free but too small

    def test_paid_lists_stay_out(self):
        self.assertFalse(scout.is_free('openrouter/z-ai/glm-5.3'))       # no :free mark
        self.assertFalse(scout.is_free('zai/glm-5.3'))                   # Z.ai bills its non-Flash models
        self.assertFalse(scout.is_free('opencode/glm-5.3'))              # Zen's paid one


if __name__ == '__main__':
    unittest.main()
