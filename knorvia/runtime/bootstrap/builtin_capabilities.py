"""Built-in capability class paths."""

BUILTIN_CAPABILITY_CLASSES: dict[str, str] = {
    "chat": "knorvia.agents.chat.capability:ChatCapability",
    "deep_solve": "knorvia.capabilities.solve.capability:DeepSolveCapability",
    "deep_question": "knorvia.agents.question.capability:DeepQuestionCapability",
    "deep_research": "knorvia.agents.research.capability:DeepResearchCapability",
    "math_animator": "knorvia.agents.math_animator.capability:MathAnimatorCapability",
    "visualize": "knorvia.agents.visualize.capability:VisualizeCapability",
    "mastery_path": "knorvia.capabilities.mastery.capability:MasteryPathCapability",
}
