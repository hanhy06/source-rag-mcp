package demo;

public final class DurableItem {
    public void damageAndBreak(int amount) {
        int applied = Math.max(0, amount);
        this.durability -= applied;
        if (this.durability <= 0) {
            this.breakItem();
        }
    }

    private void breakItem() {
    }

    private int durability = 100;
}
