package demo;

public final class DurableItem {
    public void damageAndBreak(int amount) {
        this.durability -= amount;
        if (this.durability <= 0) {
            this.breakItem();
        }
    }

    public String renderPiglinPose() {
        return "ATTACKING_WITH_MELEE_WEAPON";
    }

    private void breakItem() {
    }

    private int durability = 100;
}
