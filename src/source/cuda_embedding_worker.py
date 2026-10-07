import argparse
import json
import sys

import torch
from sentence_transformers import SentenceTransformer


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--cache-dir", required=True)
    parser.add_argument("--max-tokens", required=True, type=int)
    args = parser.parse_args()
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA PyTorch and a supported NVIDIA GPU are required; CPU fallback is disabled.")
    if not torch.cuda.is_bf16_supported():
        raise RuntimeError("The CUDA embedding backend requires bfloat16 support.")
    torch.set_num_threads(4)
    model = SentenceTransformer(
        args.model,
        device="cuda",
        cache_folder=args.cache_dir,
        config_kwargs={"vision_config": None, "audio_config": None},
        model_kwargs={"dtype": torch.bfloat16, "attn_implementation": "sdpa"},
    )
    model.max_seq_length = args.max_tokens
    if any(parameter.device.type != "cuda" for parameter in model.parameters()):
        raise RuntimeError("All embedding model parameters must reside on CUDA.")
    print(f"[source-rag] CUDA embedding ready: {torch.cuda.get_device_name(0)}, bfloat16, text only", file=sys.stderr, flush=True)
    for line in sys.stdin:
        request = json.loads(line)
        try:
            with torch.inference_mode():
                vectors = model.encode(request["texts"], batch_size=len(request["texts"]), prompt="", convert_to_tensor=True, show_progress_bar=False)
                if not torch.isfinite(vectors).all():
                    raise RuntimeError("EmbeddingGemma 2 returned non-finite values.")
                response = {"id": request["id"], "vectors": vectors.float().cpu().tolist()}
        except Exception as error:
            response = {"id": request["id"], "error": str(error)}
        print(json.dumps(response, allow_nan=False), flush=True)


if __name__ == "__main__":
    main()
